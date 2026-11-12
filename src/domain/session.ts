export type SessionStatus = "ACTIVE" | "PR_OPEN" | "MERGED" | "DISCARDED";

export interface SessionState {
  pk: "mapping";
  sk: "state";
  repository: string;
  sessionId?: string;
  sessionUrl?: string;
  status?: SessionStatus;
  generation: number;
  startedAt?: string;
  updatedAt: string;
  lastBatchId?: string;
  pendingDeliveryId?: string;
  suppressionPending?: {
    id: string;
    alarmNames: string[];
    until: string;
    transitionAt: string;
    reason: "merged" | "known-issue";
  };
  // When the most recent session was started. Drives the invocation-rate cap;
  // independent of startedAt only in that it survives across the state's life.
  lastSessionStartedAt?: string;
  // Distinct CloudWatch AlarmNames the current session is handling; the webhook
  // uses them to set post-disposition suppression when the PR is retired.
  alarmNames?: string[];
  // ISO timestamps of recent session starts, pruned to the budget window; the
  // global session budget is enforced against this list.
  recentStarts?: string[];
  prNumber?: number;
  prUrl?: string;
  prHeadRef?: string;
  prHeadSha?: string;
  prRegistrationRevision?: number;
  prEventUpdatedAt?: string;
  prState?: string;
  prUpdatedAt?: string;
  prEventOrder?: string;
  mergedAt?: string;
  discardedAt?: string;
}

export function isTerminalStatus(status: SessionStatus | undefined): boolean {
  return status === "MERGED" || status === "DISCARDED";
}

// The controller never steers a live cloud session (setup-token credentials
// lack the scope that `claude --cloud` bootstrap requires), so at most one
// session runs per mapping and later alerts are buffered for the next one.
// The slot is free when there is no session, the last one reached a terminal
// disposition, or an ACTIVE/PR_OPEN one has outlived maxAgeMs -- i.e. it
// crashed or was abandoned without ever merging or closing its PR.
export function isSlotFree(state: SessionState | undefined, now: number, maxAgeMs: number): boolean {
  if (!state?.sessionId) return true;
  if (isTerminalStatus(state.status)) return true;
  const startedAt = Date.parse(state.startedAt ?? "");
  return Number.isFinite(startedAt) && now - startedAt > maxAgeMs;
}

// Invocation-rate cap: at least cooldownMs must separate two session starts.
export function cooldownElapsed(state: SessionState | undefined, now: number, cooldownMs: number): boolean {
  const last = state?.lastSessionStartedAt ? Date.parse(state.lastSessionStartedAt) : 0;
  return now - (Number.isFinite(last) ? last : 0) >= cooldownMs;
}

// A new session may start only when the concurrency slot is free and the
// invocation-rate cooldown has elapsed. Buffered alerts wait until both hold.
export function canStartSession(
  state: SessionState | undefined,
  now: number,
  cooldownMs: number,
  maxAgeMs: number,
): boolean {
  return isSlotFree(state, now, maxAgeMs) && cooldownElapsed(state, now, cooldownMs);
}

// Retained for the PR webhook, which only ever advances a matching session to a
// terminal disposition; it never starts one.
export function shouldStartNewSession(state: SessionState | undefined): boolean {
  return !state?.sessionId || isTerminalStatus(state.status);
}

// ---------------------------------------------------------------------------
// Anti-flap: per-alarm suppression, and a global session budget.
// ---------------------------------------------------------------------------

// One suppression record per CloudWatch AlarmName. While now < until, alerts for
// that alarm are dropped from a batch so the controller does not re-open a
// near-duplicate incident for an alarm it already handled.
export interface SuppressionRecord {
  pk: "suppress";
  sk: string; // the AlarmName
  until: string; // ISO; suppressed while Date.now() < until
  strikes: number; // consecutive handlings within the reset window
  lastSeen: string; // ISO of the last handling
  reason: "backoff" | "merged" | "known-issue";
  expiresAt: number; // DynamoDB TTL (epoch seconds)
}

export function isSuppressed(record: SuppressionRecord | undefined, now: number): boolean {
  if (!record) return false;
  const until = Date.parse(record.until);
  return Number.isFinite(until) && until > now;
}

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  resetMs: number;
}

// Exponential backoff for an alarm the controller is (again) handling. Strikes
// grow only while the alarm keeps recurring inside resetMs; a longer quiet gap
// resets it so a genuinely new occurrence is treated fresh.
export function nextBackoff(
  record: SuppressionRecord | undefined,
  now: number,
  options: BackoffOptions,
): { until: number; strikes: number } {
  const priorStrikes =
    record && Number.isFinite(Date.parse(record.lastSeen)) && now - Date.parse(record.lastSeen) <= options.resetMs
      ? record.strikes
      : 0;
  const strikes = priorStrikes + 1;
  const window = Math.min(options.baseMs * 2 ** (strikes - 1), options.maxMs);
  return { until: now + window, strikes };
}

// Global session budget: at most `budget` starts per rolling `windowMs`.
export function pruneStarts(recentStarts: string[] | undefined, now: number, windowMs: number): string[] {
  return (recentStarts ?? []).filter((ts) => {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) && now - parsed < windowMs;
  });
}

export function withinBudget(
  recentStarts: string[] | undefined,
  now: number,
  windowMs: number,
  budget: number,
): boolean {
  return pruneStarts(recentStarts, now, windowMs).length < budget;
}
