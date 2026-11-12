export function normalizeSessionId(value: string): string {
  return value.replace(/^cse_/, "session_");
}

export function extractClaudeSessionId(body: string | null | undefined): string | undefined {
  return extractClaudeSessionIds(body)[0];
}

export function extractClaudeSessionIds(body: string | null | undefined): string[] {
  if (!body) return [];
  const matches = body.matchAll(/https:\/\/claude\.ai\/code\/(session_[A-Za-z0-9_-]+|cse_[A-Za-z0-9_-]+)/g);
  return [...new Set([...matches].flatMap((match) => match[1] ? [normalizeSessionId(match[1])] : []))];
}

export function hasKnownIssueDisposition(body: string | null | undefined): boolean {
  return /<!--\s*self-healing-disposition:\s*known-issue\s*-->/i.test(body ?? "");
}

export function pullRequestEventOrder(
  updatedAt: string,
  action: string,
  state: "open" | "closed",
  merged: boolean,
): string {
  const rank = merged ? 4 : action === "reopened" ? 3 : state === "closed" ? 2 : action === "opened" ? 1 : 0;
  return `${new Date(updatedAt).toISOString()}#${rank}`;
}

export function timingSafeSignatureHeader(value: string | undefined): string | undefined {
  if (!value?.startsWith("sha256=")) return undefined;
  const digest = value.slice("sha256=".length);
  return /^[a-f0-9]{64}$/i.test(digest) ? digest.toLowerCase() : undefined;
}
