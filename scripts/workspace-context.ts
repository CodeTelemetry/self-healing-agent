import { OnboardingSession, type ToolContext } from "@codetelemetry/mcp";
import { readCodexKey, resolveCodexConfigPath } from "@codetelemetry/mcp/client/codexConfig";

export function readContext(): ToolContext {
  const session = new OnboardingSession();
  // A selected workspace restores its own credential and verifies its scope.
  if (!process.env.CODETELEMETRY_WORKSPACE) {
    const key = process.env.CODETELEMETRY_INGEST_KEY ?? readCodexKey(resolveCodexConfigPath());
    if (key) session.setKey(key, "pasted");
  }
  return { session };
}
