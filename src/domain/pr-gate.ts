import { z } from "zod";

export const STRICT_GATE_POLICY = {
  enabled: true, minScore: 100, missingScore: "fail", complexityAware: false, requireTestBeforePush: true,
} as const;

const strictPolicy = z.object({
  enabled: z.literal(true), minScore: z.literal(100), missingScore: z.literal("fail"),
  complexityAware: z.literal(false), requireTestBeforePush: z.literal(true),
});

export function assertStrictGate(policy: unknown): void {
  if (!strictPolicy.safeParse(policy).success) throw new Error("PR gate did not retain the required score, missing-score, and before-push policy");
}
