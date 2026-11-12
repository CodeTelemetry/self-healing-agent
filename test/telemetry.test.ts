import { describe, expect, it } from "vitest";
import { telemetryConfiguration } from "../src/domain/telemetry.js";

describe("self-healing telemetry scope", () => {
  it("uses a workflow environment independently of the target repository", () => {
    expect(telemetryConfiguration()).toEqual({
      environment: "self-healing-agent",
      resourceAttributes: "env=self-healing-agent,deployment.environment=claude-cloud",
    });
    const first = telemetryConfiguration({ mappingId: "payments", stage: "prod" });
    const second = telemetryConfiguration({ mappingId: "orders", stage: "prod" });
    expect(first.environment).toBe(second.environment);
    expect(first.resourceAttributes).toContain("self_healing.mapping_id=payments");
    expect(second.resourceAttributes).toContain("self_healing.mapping_id=orders");
    expect(first.resourceAttributes).not.toContain("project.path");
    expect(first.resourceAttributes).not.toContain("session.id");
  });

  it("supports a distinct environment when a mapping needs a different grader", () => {
    expect(telemetryConfiguration({ environment: "self-healing-prod-orders", mappingId: "orders", stage: "prod" })).toEqual({
      environment: "self-healing-prod-orders",
      resourceAttributes: "env=self-healing-prod-orders,deployment.environment=claude-cloud,self_healing.mapping_id=orders,self_healing.stage=prod",
    });
  });

  it.each([{ mappingId: "orders" }, { stage: "prod" }])("rejects incomplete attribution: %j", scope => {
    expect(() => telemetryConfiguration(scope)).toThrow(/supplied together/);
  });

  it.each(["", "a".repeat(65), "workflow,env=other", "workflow\nother", "workflow name"])("rejects invalid environment %j", environment => {
    expect(() => telemetryConfiguration({ environment })).toThrow(/environment/);
  });

  it.each(["orders,env=other", "orders=other", "orders\nother", ""])("rejects invalid mapping tag %j", mappingId => {
    expect(() => telemetryConfiguration({ mappingId, stage: "prod" })).toThrow(/mappingId/);
  });
});
