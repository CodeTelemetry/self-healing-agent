import { describe, expect, it } from "vitest";
import { captureConfiguration } from "../src/domain/capture.js";
import { assertStrictGate, STRICT_GATE_POLICY } from "../src/domain/pr-gate.js";

describe("publication defaults", () => {
  it("does not export prompt/tool content or raw API bodies without opt-in", () => {
    expect(captureConfiguration()).toEqual({ OTEL_LOG_USER_PROMPTS: "0", OTEL_LOG_TOOL_DETAILS: "1", OTEL_LOG_TOOL_CONTENT: "0", OTEL_LOG_RAW_API_BODIES: "0" });
    expect(captureConfiguration({ content: true }).OTEL_LOG_RAW_API_BODIES).toBe("0");
    expect(() => captureConfiguration({ rawApiBodies: true })).toThrow(/explicit/);
  });
  it("rejects any weakening of the required gate policy", () => {
    expect(() => assertStrictGate(STRICT_GATE_POLICY)).not.toThrow();
    for (const changed of [{ enabled: false }, { minScore: 70 }, { missingScore: "pass" }, { requireTestBeforePush: false }, { complexityAware: true }]) {
      expect(() => assertStrictGate({ ...STRICT_GATE_POLICY, ...changed })).toThrow(/required/);
    }
  });
});
