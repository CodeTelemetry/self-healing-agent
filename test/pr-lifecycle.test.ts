import { createHmac } from "node:crypto";
import type { APIGatewayProxyEventV2, Context } from "aws-lambda";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ database: vi.fn(), secret: vi.fn() }));
vi.mock("@aws-sdk/client-dynamodb", () => ({ DynamoDBClient: class {} }));
vi.mock("@aws-sdk/lib-dynamodb", () => ({
  DynamoDBDocumentClient: { from: () => ({ send: mocks.database }) },
  GetCommand: class { constructor(public input: unknown) {} },
  UpdateCommand: class { constructor(public input: unknown) {} },
  BatchWriteCommand: class { constructor(public input: unknown) {} },
}));
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  SecretsManagerClient: class { send = mocks.secret; }, GetSecretValueCommand: class { constructor(public input: unknown) {} },
}));
import { handler as webhook } from "../src/handlers/github-webhook.js";
import { handler as register } from "../src/handlers/pr-registration.js";

const token = "synthetic-registration-capability-for-tests-only";
const sha = "a".repeat(40);
const state = { pk: "mapping", sk: "state", repository: "owner/target-repository", sessionId: "session_synthetic", generation: 3, status: "PR_OPEN", prNumber: 7, prHeadRef: "claude/incident", prHeadSha: sha };
const registration = { sessionId: "cse_synthetic", pullRequestNumber: 7, headRef: "claude/incident", headSha: sha, expectedRevision: 0 };
const conflict = () => Object.assign(new Error("race"), { name: "ConditionalCheckFailedException" });
const invoke = async (handler: typeof webhook, event: Record<string, unknown>) => {
  const result = await handler(event as unknown as APIGatewayProxyEventV2, {} as Context, () => {});
  if (!result || typeof result !== "object") throw new Error("Expected HTTP result");
  return result;
};
const registerEvent = (payload = registration, authorization = `Bearer ${token}`) => ({ body: JSON.stringify(payload), headers: { authorization } });
function githubEvent(options: { number?: number; action?: string; updatedAt?: string; headSha?: string; headRepository?: string; body?: string; merged?: boolean; prState?: string } = {}) {
  const number = options.number ?? 7;
  const action = options.action ?? "closed";
  const body = JSON.stringify({ action, repository: { full_name: "owner/target-repository" }, pull_request: {
    number, html_url: `https://github.com/owner/target-repository/pull/${number}`,
    body: options.body ?? "https://claude.ai/code/session_synthetic",
    state: options.prState ?? (action === "closed" ? "closed" : "open"), merged: options.merged ?? action === "closed",
    merged_at: action === "closed" ? "2026-11-09T12:00:00Z" : null,
    updated_at: options.updatedAt ?? "2026-11-09T12:00:00Z",
    head: { ref: "claude/incident", sha: options.headSha ?? sha, repo: { full_name: options.headRepository ?? "owner/target-repository" } },
  } });
  return { body, headers: { "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", token).update(body).digest("hex")}` } };
}
beforeEach(() => {
  vi.resetAllMocks();
  process.env.REPOSITORY = "owner/target-repository";
  process.env.STATE_TABLE_NAME = "synthetic";
  mocks.secret.mockResolvedValue({ SecretString: JSON.stringify({ token }) });
  mocks.database.mockResolvedValue({ Item: { ...state } });
});

describe("authenticated PR registration", () => {
  it("rejects callers without the dedicated capability", async () => {
    expect((await invoke(register, registerEvent(registration, "Bearer wrong"))).statusCode).toBe(401);
    expect(mocks.database).not.toHaveBeenCalled();
  });
  it("pins the first trusted PR, branch, and SHA conditionally to its generation", async () => {
    mocks.database.mockResolvedValueOnce({ Item: { ...state, prNumber: 999, prHeadRef: undefined, prHeadSha: undefined } }).mockResolvedValueOnce({});
    expect((await invoke(register, registerEvent())).statusCode).toBe(200);
    const update = mocks.database.mock.calls[1]![0].input;
    expect(update.ExpressionAttributeValues[":number"]).toBe(7);
    expect(update.ExpressionAttributeValues[":sha"]).toBe(sha);
    expect(update.ConditionExpression).toContain("generation = :generation");
    expect(update.ConditionExpression).toContain("#status <> :merged");
  });
  it("does not clear ordering data on an idempotent retry", async () => {
    expect((await invoke(register, registerEvent())).statusCode).toBe(200);
    expect(mocks.database).toHaveBeenCalledTimes(1);
  });
  it("allows a new pushed head only on the registered PR and branch", async () => {
    expect((await invoke(register, registerEvent({ ...registration, headSha: "b".repeat(40) }))).statusCode).toBe(200);
    expect(mocks.database).toHaveBeenCalledTimes(2);
  });
  it.each([
    { ...registration, pullRequestNumber: 999 }, { ...registration, headRef: "other" }, { ...registration, sessionId: "session_other" },
  ])("rejects rebinding or a different cloud session: %j", async payload => {
    expect((await invoke(register, registerEvent(payload))).statusCode).toBe(409);
    expect(mocks.database).toHaveBeenCalledTimes(1);
  });
  it("never reopens a merged incident", async () => {
    mocks.database.mockResolvedValue({ Item: { ...state, status: "MERGED" } });
    expect((await invoke(register, registerEvent())).statusCode).toBe(409);
    expect(mocks.database).toHaveBeenCalledTimes(1);
  });
  it("never reopens a known-issue terminal incident", async () => {
    mocks.database.mockResolvedValue({ Item: { ...state, status: "DISCARDED" } });
    expect((await invoke(register, registerEvent())).statusCode).toBe(409);
    expect(mocks.database).toHaveBeenCalledTimes(1);
  });
  it("returns a conflict if the generation changes during registration", async () => {
    mocks.database.mockResolvedValueOnce({ Item: { ...state, prHeadSha: undefined, prHeadRef: undefined } }).mockRejectedValueOnce(conflict());
    expect((await invoke(register, registerEvent())).statusCode).toBe(409);
  });
  it("bounds and validates authenticated payloads", async () => {
    expect((await invoke(register, { body: "x".repeat(12_001), headers: {} })).statusCode).toBe(413);
    expect((await invoke(register, { body: "{", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(400);
    expect(mocks.database).not.toHaveBeenCalled();
  });
});

describe("registered PR lifecycle", () => {
  it("retains known-issue disposition and seven-day alarm suppression", async () => {
    mocks.database.mockResolvedValueOnce({ Item: { ...state, alarmNames: ["synthetic-alarm"] } }).mockResolvedValue({});
    expect((await invoke(webhook, githubEvent({ merged: false, body: "<!-- self-healing-disposition: known-issue -->" }))).statusCode).toBe(200);
    const update = mocks.database.mock.calls[1]![0].input;
    expect(update.ExpressionAttributeValues[":status"]).toBe("DISCARDED");
    const work = update.ExpressionAttributeValues[":work"];
    expect(work.reason).toBe("known-issue");
    expect(Date.parse(work.until) - Date.parse(work.transitionAt)).toBe(7 * 24 * 60 * 60_000);
  });
  it("retains the post-merge suppression window", async () => {
    mocks.database.mockResolvedValueOnce({ Item: { ...state, alarmNames: ["synthetic-alarm"] } }).mockResolvedValue({});
    await invoke(webhook, githubEvent());
    const work = mocks.database.mock.calls[1]![0].input.ExpressionAttributeValues[":work"];
    expect(work.reason).toBe("merged");
    expect(Date.parse(work.until) - Date.parse(work.transitionAt)).toBe(240 * 60_000);
  });
  it("keeps an edited closed PR closed and rejects repeated event ranks", async () => {
    const result = await invoke(webhook, githubEvent({ action: "edited", prState: "closed", merged: false }));
    expect(JSON.parse(result.body as string).prState).toBe("CLOSED_UNMERGED");
    mocks.database.mockClear().mockResolvedValue({ Item: { ...state, prEventOrder: "2026-11-09T12:00:00.000Z#3" } });
    expect((await invoke(webhook, githubEvent({ action: "closed", merged: false }))).statusCode).toBe(202);
    expect(mocks.database).toHaveBeenCalledTimes(1);
  });
  it("ignores reopened events on a known-issue terminal generation", async () => {
    mocks.database.mockResolvedValue({ Item: { ...state, status: "DISCARDED" } });
    expect((await invoke(webhook, githubEvent({ action: "reopened" }))).statusCode).toBe(202);
    expect(mocks.database).toHaveBeenCalledTimes(1);
  });
  it("rejects a copied session link on another PR", async () => {
    expect((await invoke(webhook, githubEvent({ number: 999 }))).statusCode).toBe(202);
    expect(mocks.database).toHaveBeenCalledTimes(1);
  });
  it("ignores stale opened events after merge", async () => {
    mocks.database.mockResolvedValue({ Item: { ...state, status: "MERGED" } });
    expect((await invoke(webhook, githubEvent({ action: "opened" }))).statusCode).toBe(202);
    expect(mocks.database).toHaveBeenCalledTimes(1);
  });
  it("ignores old events within an open generation", async () => {
    mocks.database.mockResolvedValue({ Item: { ...state, prEventUpdatedAt: "2026-11-09T13:00:00.000Z" } });
    expect((await invoke(webhook, githubEvent({ action: "edited" }))).statusCode).toBe(202);
    expect(mocks.database).toHaveBeenCalledTimes(1);
  });
  it.each([{ headSha: "b".repeat(40) }, { headRepository: "other/fork" }])("rejects an unregistered head: %j", async options => {
    expect((await invoke(webhook, githubEvent(options))).statusCode).toBe(202);
    expect(mocks.database).toHaveBeenCalledTimes(1);
  });
  it("does not use a PR body link as first-registration authority", async () => {
    mocks.database.mockResolvedValue({ Item: { ...state, prHeadRef: undefined, prHeadSha: undefined } });
    expect((await invoke(webhook, githubEvent())).statusCode).toBe(202);
    expect(mocks.database).toHaveBeenCalledTimes(1);
  });
  it("accepts only the registered merge and makes terminality atomic", async () => {
    expect((await invoke(webhook, githubEvent({ body: "no session link needed" }))).statusCode).toBe(200);
    const update = mocks.database.mock.calls[1]![0].input;
    expect(update.ExpressionAttributeValues[":status"]).toBe("MERGED");
    expect(update.ConditionExpression).toContain("#status <> :terminal");
    expect(update.ConditionExpression).toContain("prHeadSha = :sha");
  });
  it("treats a concurrent merge or generation replacement as ignored", async () => {
    mocks.database.mockResolvedValueOnce({ Item: { ...state } }).mockRejectedValueOnce(conflict());
    expect((await invoke(webhook, githubEvent({ action: "opened" }))).statusCode).toBe(202);
  });
  it("verifies signatures before reading incident state", async () => {
    expect((await invoke(webhook, { ...githubEvent(), headers: { "x-hub-signature-256": "sha256=" + "0".repeat(64) } })).statusCode).toBe(401);
    expect(mocks.database).not.toHaveBeenCalled();
  });
});
