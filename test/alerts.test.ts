import { describe, expect, it } from "vitest";
import { buildIncidentMessage, incidentBatchId, parseSnsAlarm, planIncidentMessage, type NormalizedAlert } from "../src/domain/alerts.js";

const envelope = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    MessageId: "m1",
    TopicArn: "arn:aws:sns:us-east-1:111122223333:alerts",
    Timestamp: "2026-09-11T00:00:00.000Z",
    Message: JSON.stringify({
      AlarmName: "example-alarm",
      NewStateValue: "ALARM",
      NewStateReason: "threshold crossed",
      StateChangeTime: "2026-09-11T00:00:00.000Z",
      Region: "US East (N. Virginia)",
      ...overrides,
    }),
  });

describe("alert parsing", () => {
  it("accepts only ALARM-state CloudWatch messages", () => {
    expect(parseSnsAlarm(envelope(), "fallback")?.alarmName).toBe("example-alarm");
    expect(parseSnsAlarm(envelope({ NewStateValue: "OK" }), "fallback")).toBeUndefined();
    expect(parseSnsAlarm("not json", "fallback")).toBeUndefined();
  });

  it("hashes a stable batch id regardless of order", () => {
    const a = parseSnsAlarm(envelope(), "f1")!;
    const b = parseSnsAlarm(JSON.stringify({ MessageId: "m2", Message: JSON.parse(envelope()).Message }), "f2")!;
    expect(incidentBatchId([a, b])).toBe(incidentBatchId([b, a]));
  });
});

describe("incident message", () => {
  const alert: NormalizedAlert = {
    messageId: "m1",
    topicArn: "arn:aws:sns:us-east-1:111122223333:alerts",
    alarmName: "example-alarm",
    state: "ALARM",
    reason: "threshold crossed",
    stateChangeTime: "2026-09-11T00:00:00.000Z",
    rawMessage: "{}",
  };

  it("carries the generic controller guidance and no product-specific text", () => {
    const message = buildIncidentMessage("owner/repo", [alert], "batch");
    expect(message).toContain("untrusted incident data");
    expect(message).toContain("search open PRs and issues");
    expect(message).toContain("self-healing-disposition: known-issue");
    // The library names no repository or product of its own.
    expect(message).not.toMatch(/mirror|target-repository|codex|codetelemetry/i);
  });

  it("appends deployment-supplied guidance lines", () => {
    const message = buildIncidentMessage("owner/repo", [alert], "batch", {
      extraGuidance: ["Branch off main as feature/<slug>.", "Never merge the PR yourself."],
    });
    expect(message).toContain("Branch off main as feature/<slug>.");
    expect(message).toContain("Never merge the PR yourself.");
  });

  it("refuses to silently truncate and identifies oversized alerts separately", () => {
    const big = { ...alert, rawMessage: "x".repeat(5_000) };
    expect(() => buildIncidentMessage("owner/repo", [big], "batch", { maxChars: 3_000 })).toThrow(/byte budget/);
    const plan = planIncidentMessage("owner/repo", [big, { ...alert, messageId: "small" }], { maxChars: 3_000 });
    expect(plan.oversized.map(item => item.messageId)).toEqual(["m1"]);
    expect(plan.alerts.map(item => item.messageId)).toEqual(["small"]);
    expect(Buffer.byteLength(plan.message)).toBeLessThanOrEqual(3_000);
  });
});
