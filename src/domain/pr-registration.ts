import { z } from "zod";

export const registrationSchema = z.object({
  sessionId: z.string().regex(/^(session_|cse_)[A-Za-z0-9_-]{1,200}$/),
  pullRequestNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  headRef: z.string().min(1).max(255).regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  headSha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
}).strict();

export function isConditionalConflict(error: unknown): boolean {
  return error instanceof Error && error.name === "ConditionalCheckFailedException";
}
