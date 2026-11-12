import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ secret: vi.fn(), sts: vi.fn(), cloudwatch: vi.fn() }));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class { send = mocks.secret; },
  GetSecretValueCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-sts", () => ({
  STSClient: class { send = mocks.sts; },
  GetCallerIdentityCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-cloudwatch", () => ({
  CloudWatchClient: class { send = mocks.cloudwatch; },
  DescribeAlarmsCommand: class { constructor(public input: unknown) {} },
  PutMetricDataCommand: class { constructor(public input: unknown) {} },
}));
import { handler } from "../src/handlers/access-health.js";

const issued = {
  Version: 1, AccessKeyId: "access", SecretAccessKey: "secret", SessionToken: "session",
  Expiration: new Date(Date.now() + 3600_000).toISOString(),
};
beforeEach(() => {
  vi.clearAllMocks();
  process.env.STAGE = "test";
  process.env.READ_ONLY_ROLE_ARN = "arn:aws:iam::111122223333:role/readonly";
  process.env.BROKER_URL = "https://broker.example/v1/credentials";
  mocks.secret.mockResolvedValue({ SecretString: JSON.stringify({ token: "t".repeat(48) }) });
  mocks.sts.mockResolvedValue({ Account: "111122223333", Arn: "arn:aws:sts::111122223333:assumed-role/readonly/check" });
  mocks.cloudwatch.mockResolvedValue({});
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => issued }));
});
function lastHealth() {
  return mocks.cloudwatch.mock.calls.at(-1)?.[0].input.MetricData[0].Value;
}
describe("read-only access monitor", () => {
  it("checks broker-issued identity and permissions before reporting success", async () => {
    await handler();
    expect(mocks.sts).toHaveBeenCalledOnce();
    expect(mocks.cloudwatch).toHaveBeenCalledTimes(2);
    expect(lastHealth()).toBe(1);
  });
  it("reports denied broker requests without using fallback credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401 }));
    await handler();
    expect(mocks.sts).not.toHaveBeenCalled();
    expect(lastHealth()).toBe(0);
  });
  it("rejects a valid credential response for the wrong role", async () => {
    mocks.sts.mockResolvedValue({ Account: "111122223333", Arn: "arn:aws:sts::111122223333:assumed-role/admin/check" });
    await handler();
    expect(mocks.cloudwatch).toHaveBeenCalledTimes(1);
    expect(lastHealth()).toBe(0);
  });
  it("reports permission failures even when STS identity succeeds", async () => {
    mocks.cloudwatch.mockRejectedValueOnce(new Error("AccessDenied"));
    await handler();
    expect(lastHealth()).toBe(0);
  });
  it("lets metric publishing failures surface so missing-data detection can alarm", async () => {
    mocks.cloudwatch.mockRejectedValue(new Error("Unavailable"));
    await expect(handler()).rejects.toThrow("Unavailable");
  });
});
