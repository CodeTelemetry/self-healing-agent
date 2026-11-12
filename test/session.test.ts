import { describe, expect, it } from "vitest";
import {
  canStartSession,
  cooldownElapsed,
  isSlotFree,
  isSuppressed,
  nextBackoff,
  pruneStarts,
  shouldStartNewSession,
  withinBudget,
  type SessionState,
  type SuppressionRecord,
} from "../src/domain/session.js";

const NOW = Date.parse("2026-09-11T02:00:00.000Z");
const COOLDOWN = 30 * 60_000;
const MAX_AGE = 360 * 60_000;
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const base: SessionState = {
  pk: "mapping",
  sk: "state",
  repository: "owner/repo",
  sessionId: "session_1",
  sessionUrl: "https://claude.ai/code/session_1",
  status: "ACTIVE",
  generation: 1,
  startedAt: ago(5),
  updatedAt: ago(5),
  lastBatchId: "batch",
  lastSessionStartedAt: ago(5),
};

describe("session start gating", () => {
  it("frees the slot only with no session, a terminal one, or an abandoned one", () => {
    expect(isSlotFree(undefined, NOW, MAX_AGE)).toBe(true);
    expect(isSlotFree(base, NOW, MAX_AGE)).toBe(false); // ACTIVE, fresh
    expect(isSlotFree({ ...base, status: "PR_OPEN" }, NOW, MAX_AGE)).toBe(false);
    expect(isSlotFree({ ...base, status: "MERGED" }, NOW, MAX_AGE)).toBe(true);
    expect(isSlotFree({ ...base, status: "DISCARDED" }, NOW, MAX_AGE)).toBe(true);
    // ACTIVE but older than max age -> abandoned, slot reclaimable
    expect(isSlotFree({ ...base, startedAt: ago(7 * 60) }, NOW, MAX_AGE)).toBe(true);
  });

  it("enforces the invocation-rate cooldown from the last start", () => {
    expect(cooldownElapsed({ ...base, lastSessionStartedAt: ago(10) }, NOW, COOLDOWN)).toBe(false);
    expect(cooldownElapsed({ ...base, lastSessionStartedAt: ago(40) }, NOW, COOLDOWN)).toBe(true);
    // no recorded start (fresh mapping / legacy state) -> cooldown satisfied
    const { lastSessionStartedAt: _drop, ...noLastStart } = base;
    expect(cooldownElapsed(noLastStart, NOW, COOLDOWN)).toBe(true);
    expect(cooldownElapsed(undefined, NOW, COOLDOWN)).toBe(true);
  });

  it("starts only when the slot is free AND the cooldown has elapsed", () => {
    expect(canStartSession(undefined, NOW, COOLDOWN, MAX_AGE)).toBe(true);
    // active session blocks regardless of cooldown (concurrency cap = 1)
    expect(canStartSession({ ...base, lastSessionStartedAt: ago(40) }, NOW, COOLDOWN, MAX_AGE)).toBe(false);
    // merged but too soon -> rate cap blocks
    expect(canStartSession({ ...base, status: "MERGED", lastSessionStartedAt: ago(10) }, NOW, COOLDOWN, MAX_AGE)).toBe(false);
    // merged and cooldown elapsed -> start
    expect(canStartSession({ ...base, status: "MERGED", lastSessionStartedAt: ago(40) }, NOW, COOLDOWN, MAX_AGE)).toBe(true);
    // abandoned active session past max age, cooldown long elapsed -> reclaim
    expect(
      canStartSession({ ...base, startedAt: ago(7 * 60), lastSessionStartedAt: ago(7 * 60) }, NOW, COOLDOWN, MAX_AGE),
    ).toBe(true);
  });

  it("marks a fresh start needed only from no state or a terminal disposition", () => {
    expect(shouldStartNewSession(undefined)).toBe(true);
    expect(shouldStartNewSession(base)).toBe(false);
    expect(shouldStartNewSession({ ...base, status: "MERGED" })).toBe(true);
    expect(shouldStartNewSession({ ...base, status: "DISCARDED" })).toBe(true);
  });
});

describe("anti-flap: per-alarm suppression", () => {
  const rec = (over: Partial<SuppressionRecord> = {}): SuppressionRecord => ({
    pk: "suppress",
    sk: "alarm-x",
    until: new Date(NOW + 60_000).toISOString(),
    strikes: 1,
    lastSeen: new Date(NOW).toISOString(),
    reason: "backoff",
    expiresAt: Math.floor(NOW / 1000) + 3600,
    ...over,
  });

  it("suppresses only while now < until", () => {
    expect(isSuppressed(rec({ until: new Date(NOW + 60_000).toISOString() }), NOW)).toBe(true);
    expect(isSuppressed(rec({ until: new Date(NOW - 1).toISOString() }), NOW)).toBe(false);
    expect(isSuppressed(undefined, NOW)).toBe(false);
  });

  it("grows the backoff window exponentially while the alarm keeps recurring", () => {
    const opts = { baseMs: 120 * 60_000, maxMs: 1440 * 60_000, resetMs: 1440 * 60_000 };
    const first = nextBackoff(undefined, NOW, opts);
    expect(first.strikes).toBe(1);
    expect(first.until - NOW).toBe(120 * 60_000); // 2h
    const second = nextBackoff(rec({ strikes: 1, lastSeen: new Date(NOW - 60_000).toISOString() }), NOW, opts);
    expect(second.strikes).toBe(2);
    expect(second.until - NOW).toBe(240 * 60_000); // 4h
    const capped = nextBackoff(rec({ strikes: 10, lastSeen: new Date(NOW - 60_000).toISOString() }), NOW, opts);
    expect(capped.until - NOW).toBe(1440 * 60_000); // capped at 24h
  });

  it("resets strikes after a quiet gap longer than resetMs", () => {
    const opts = { baseMs: 120 * 60_000, maxMs: 1440 * 60_000, resetMs: 1440 * 60_000 };
    const stale = rec({ strikes: 5, lastSeen: new Date(NOW - 2 * 1440 * 60_000).toISOString() });
    const fresh = nextBackoff(stale, NOW, opts);
    expect(fresh.strikes).toBe(1); // treated as a new occurrence
    expect(fresh.until - NOW).toBe(120 * 60_000);
  });
});

describe("anti-flap: global session budget", () => {
  const win = 24 * 60 * 60_000;
  it("counts only starts inside the rolling window", () => {
    const starts = [
      new Date(NOW - 2 * win).toISOString(), // outside
      new Date(NOW - 60_000).toISOString(),
      new Date(NOW - 120_000).toISOString(),
    ];
    expect(pruneStarts(starts, NOW, win)).toHaveLength(2);
  });
  it("allows starts below the budget and blocks at or above it", () => {
    const recent = Array.from({ length: 8 }, (_, i) => new Date(NOW - (i + 1) * 60_000).toISOString());
    expect(withinBudget(recent.slice(0, 7), NOW, win, 8)).toBe(true);
    expect(withinBudget(recent, NOW, win, 8)).toBe(false);
    expect(withinBudget(undefined, NOW, win, 8)).toBe(true);
  });
});
