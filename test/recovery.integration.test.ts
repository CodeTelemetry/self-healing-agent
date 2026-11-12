import { randomUUID, createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { APIGatewayProxyEventV2, Context, ScheduledEvent, SQSEvent } from "aws-lambda";
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient, ListTablesCommand } from "@aws-sdk/client-dynamodb";
import { BatchGetCommand, BatchWriteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { reconcileDelivery } from "../src/domain/delivery.js";

vi.mock("@aws-sdk/client-dynamodb", async importOriginal => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-dynamodb")>();
  return { ...actual, DynamoDBClient: class extends actual.DynamoDBClient {
    constructor() { super({ endpoint: process.env.DYNAMODB_TEST_ENDPOINT ?? "http://127.0.0.1:8000", region: "us-east-1", credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" }, maxAttempts: 1 }); }
  } };
});
vi.mock("@aws-sdk/client-secrets-manager", () => ({
  GetSecretValueCommand: class { constructor(public input: { SecretId: string }) {} },
  SecretsManagerClient: class { async send(command: { input: { SecretId: string } }) {
    return { SecretString: JSON.stringify(command.input.SecretId === "routine" ? { url: "https://api.anthropic.com/v1/claude_code/routines/synthetic/fire", token: "synthetic-capability-for-integration-tests" } : { token: "synthetic-capability-for-integration-tests" }) };
  } },
}));
import { handler as dispatch } from "../src/handlers/dispatcher.js";
import { handler as webhook } from "../src/handlers/github-webhook.js";
import { handler as register } from "../src/handlers/pr-registration.js";

const low = new DynamoDBClient({});
const db = DynamoDBDocumentClient.from(low);
const table = `self-healing-tests-${randomUUID()}`;
const topic = "arn:aws:sns:us-east-1:111122223333:alerts";
const token = "synthetic-capability-for-integration-tests";
const sha = "a".repeat(40);
const original = DynamoDBDocumentClient.prototype.send as (command: unknown) => Promise<any>;
let fault: ((command: any, send: () => Promise<any>) => Promise<any>) | undefined;
const fetchMock = vi.fn();
const scheduled = () => dispatch({ source: "aws.events" } as ScheduledEvent);
const read = async (pk: string, sk: string) => (await db.send(new GetCommand({ TableName: table, Key: { pk, sk }, ConsistentRead: true }))).Item;
const put = (item: Record<string, unknown>) => db.send(new PutCommand({ TableName: table, Item: item }));
const all = async () => (await db.send(new ScanCommand({ TableName: table, ConsistentRead: true }))).Items ?? [];
const active = () => ({ pk: "mapping", sk: "state", repository: "owner/target-repository", generation: 3, sessionId: "session_synthetic", sessionUrl: "https://claude.ai/code/session_synthetic", status: "PR_OPEN", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), prNumber: 7, prHeadRef: "claude/incident", prHeadSha: sha, alarmNames: ["alarm-1"] });
function event(id = "m1", alarmName = "alarm-1") {
  return { Records: [{ messageId: `sqs-${id}`, body: JSON.stringify({ MessageId: id, TopicArn: topic, Message: JSON.stringify({ AlarmName: alarmName, NewStateValue: "ALARM", NewStateReason: "synthetic", StateChangeTime: "2026-11-10T12:00:00Z" }) }) }] } as SQSEvent;
}
const pending = (id: string, options: Record<string, unknown> = {}) => ({ pk: "pending", sk: id, alert: { messageId: id, topicArn: topic, alarmName: `alarm-${id}`, state: "ALARM", reason: "synthetic", stateChangeTime: "2026-11-10T12:00:00Z", rawMessage: "{}", ...options } });
const callApi = async (handler: typeof register, value: Record<string, unknown>) => {
  const response = await handler(value as unknown as APIGatewayProxyEventV2, {} as Context, () => {});
  if (!response || typeof response !== "object") throw new Error("Missing HTTP response");
  return response;
};
const registration = (headSha: string, expectedRevision = 0) => callApi(register, { headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ sessionId: "session_synthetic", pullRequestNumber: 7, headRef: "claude/incident", headSha, expectedRevision }) });
function mergeEvent() {
  const body = JSON.stringify({ action: "closed", repository: { full_name: "owner/target-repository" }, pull_request: {
    number: 7, html_url: "https://github.com/owner/target-repository/pull/7", state: "closed", merged: true, updated_at: "2026-11-10T12:00:00Z",
    head: { ref: "claude/incident", sha, repo: { full_name: "owner/target-repository" } },
  } });
  return { body, headers: { "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", token).update(body).digest("hex")}` } };
}

describe.skipIf(!process.env.DYNAMODB_TEST_ENDPOINT)("failure recovery against DynamoDB Local", () => {
  beforeAll(async () => {
    for (let attempt = 0; ; attempt++) {
      try { await low.send(new ListTablesCommand({})); break; }
      catch (error) { if (attempt === 29) throw error; await delay(300); }
    }
    await low.send(new CreateTableCommand({ TableName: table, KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }, { AttributeName: "sk", KeyType: "RANGE" }], AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }, { AttributeName: "sk", AttributeType: "S" }], BillingMode: "PAY_PER_REQUEST" }));
    vi.spyOn(DynamoDBDocumentClient.prototype, "send").mockImplementation(function(this: DynamoDBDocumentClient, command: any): any {
      const send = () => original.call(this, command);
      return fault ? fault(command, send) : send();
    });
  }, 30_000);
  beforeEach(async () => {
    fault = undefined;
    for (const item of await all()) await db.send(new BatchWriteCommand({ RequestItems: { [table]: [{ DeleteRequest: { Key: { pk: item.pk, sk: item.sk } } }] } }));
    process.env.STATE_TABLE_NAME = table;
    process.env.REPOSITORY = "owner/target-repository";
    process.env.SNS_TOPIC_ARNS = topic;
    process.env.ROUTINE_SECRET_ARN = "routine";
    process.env.PR_REGISTRATION_SECRET_ARN = "cap";
    process.env.GITHUB_WEBHOOK_SECRET_ARN = "cap";
    fetchMock.mockReset().mockImplementation(async () => ({ ok: true, status: 200, json: async () => ({ claude_code_session_id: `session_launched_${fetchMock.mock.calls.length}`, claude_code_session_url: `https://claude.ai/code/session_launched_${fetchMock.mock.calls.length}` }) }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterAll(async () => { fault = undefined; await low.send(new DeleteTableCommand({ TableName: table })); vi.restoreAllMocks(); vi.unstubAllGlobals(); low.destroy(); });

  it("never commits a dedupe marker without its pending alert, and retries safely", async () => {
    await put(active());
    let fail = true;
    fault = async (command, send) => {
      if (command instanceof TransactWriteCommand && command.input.TransactItems?.some((item: any) => item.Put?.Item?.pk === "dedupe") && fail) { fail = false; throw new Error("injected ingestion failure"); }
      return send();
    };
    expect((await dispatch(event()))?.batchItemFailures).toEqual([{ itemIdentifier: "sqs-m1" }]);
    expect(await read("dedupe", "m1")).toBeUndefined();
    expect(await read("pending", "m1")).toBeUndefined();
    expect((await dispatch(event()))?.batchItemFailures).toEqual([]);
    expect(await read("dedupe", "m1")).toBeDefined();
    expect(await read("pending", "m1")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("handles duplicate SNS IDs inside one SQS batch without duplicate writes or launches", async () => {
    const input = event(); input.Records.push({ ...input.Records[0]!, messageId: "duplicate-sqs" });
    expect((await dispatch(input))?.batchItemFailures).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await all()).filter(item => item.pk === "delivery")).toHaveLength(1);
  });

  it("recognizes ingestion that committed before its response was lost", async () => {
    await put(active()); let fail = true;
    fault = async (command, send) => {
      const result = await send();
      if (command instanceof TransactWriteCommand && command.input.TransactItems?.some((item: any) => item.Put?.Item?.pk === "dedupe") && fail) { fail = false; throw new Error("lost transaction response"); }
      return result;
    };
    expect((await dispatch(event()))?.batchItemFailures).toEqual([]);
    expect(await read("dedupe", "m1")).toBeDefined();
    expect(await read("pending", "m1")).toBeDefined();
  });

  it("resumes a prepared reservation after a pre-request database failure", async () => {
    let fail = true;
    fault = async (command, send) => {
      if (command instanceof UpdateCommand && command.input.ExpressionAttributeValues?.[":prepared"] && fail) { fail = false; throw new Error("before request"); }
      return send();
    };
    await dispatch(event());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await read("pending", "m1")).toBeDefined();
    await scheduled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await read("mapping", "state"))!.sessionId).toBe("session_launched_1");
  });

  it.each(["reservation", "completion"])("recovers when the %s transaction committed but its response was lost", async stage => {
    let fail = true;
    fault = async (command, send) => {
      const result = await send();
      const selected = command instanceof TransactWriteCommand && command.input.TransactItems?.some((item: any) =>
        stage === "reservation" ? item.Put?.Item?.phase === "PREPARED" : item.Update?.ExpressionAttributeValues?.[":active"] === "ACTIVE");
      if (selected && fail) { fail = false; throw new Error("lost transaction response"); }
      return result;
    };
    await dispatch(event());
    expect((await read("mapping", "state"))!.pendingDeliveryId).toBeDefined();
    await scheduled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await read("mapping", "state"))!.pendingDeliveryId).toBeUndefined();
    expect(await read("pending", "m1")).toBeUndefined();
  });

  it("retains alerts if recording the returned session itself fails", async () => {
    let fail = true;
    fault = async (command, send) => {
      if (command instanceof UpdateCommand && command.input.ExpressionAttributeValues?.[":launched"] && fail) { fail = false; throw new Error("lost result persistence"); }
      return send();
    };
    await dispatch(event());
    await expect(scheduled()).rejects.toThrow(/reconciliation/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await read("pending", "m1")).toBeDefined();
  });

  it("retries a definite HTTP rejection after configuration is corrected", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });
    await dispatch(event());
    expect((await read("mapping", "state"))!.pendingDeliveryId).toBeUndefined();
    expect(await read("pending", "m1")).toBeDefined();
    await scheduled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await read("mapping", "state"))!.sessionId).toBe("session_launched_2");
  });

  it("recovers a saved launch after mapping persistence fails, without launching again", async () => {
    let fail = true;
    fault = async (command, send) => {
      if (command instanceof TransactWriteCommand && command.input.TransactItems?.some((item: any) => item.Update?.ExpressionAttributeValues?.[":active"] === "ACTIVE") && fail) { fail = false; throw new Error("injected state failure"); }
      return send();
    };
    expect((await dispatch(event()))?.batchItemFailures).toHaveLength(1);
    const reserved = await read("mapping", "state");
    expect((await read("delivery", reserved!.pendingDeliveryId))!.phase).toBe("LAUNCHED");
    expect(await read("pending", "m1")).toBeDefined();
    expect((await dispatch(event()))?.batchItemFailures).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const state = await read("mapping", "state");
    expect(state!.sessionId).toBe("session_launched_1");
    expect(state!.pendingDeliveryId).toBeUndefined();
    expect(await read("pending", "m1")).toBeUndefined();
  });

  it("retains an uncertain launch and blocks all new launches until explicit reconciliation", async () => {
    fetchMock.mockRejectedValueOnce(new Error("request may have been accepted"));
    await dispatch(event());
    const reserved = await read("mapping", "state");
    expect((await read("delivery", reserved!.pendingDeliveryId))!.phase).toBe("FIRING");
    await expect(scheduled()).rejects.toThrow(/reconciliation/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await read("pending", "m1")).toBeDefined();
    await reconcileDelivery(db, table, reserved!.pendingDeliveryId, { sessionId: "session_verified", sessionUrl: "https://claude.ai/code/session_verified" });
    await scheduled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((await read("mapping", "state"))!.sessionId).toBe("session_verified");
  });

  it("allows a verified not-started outcome to retry and rejects reconciliation of completed work", async () => {
    fetchMock.mockRejectedValueOnce(new Error("uncertain"));
    await dispatch(event());
    const state = await read("mapping", "state");
    await reconcileDelivery(db, table, state!.pendingDeliveryId, "not-started");
    await scheduled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await expect(reconcileDelivery(db, table, state!.pendingDeliveryId, "not-started")).rejects.toMatchObject({ name: "TransactionCanceledException" });
  });

  it("retries only unprocessed cleanup writes before releasing the launch reservation", async () => {
    let partial = true;
    fault = async (command, send) => {
      if (command instanceof BatchWriteCommand && partial) { partial = false; return { UnprocessedItems: command.input.RequestItems }; }
      return send();
    };
    expect((await dispatch(event()))?.batchItemFailures).toEqual([]);
    expect(await read("pending", "m1")).toBeUndefined();
    expect((await read("mapping", "state"))!.pendingDeliveryId).toBeUndefined();
  });

  it("repairs exhausted cleanup writes on the next flush without another routine call", async () => {
    fault = async (command, send) => command instanceof BatchWriteCommand ? { UnprocessedItems: command.input.RequestItems } : send();
    await dispatch(event());
    expect(await read("pending", "m1")).toBeDefined();
    expect((await read("mapping", "state"))!.pendingDeliveryId).toBeDefined();
    fault = undefined;
    await scheduled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await read("pending", "m1")).toBeUndefined();
  });

  it("retries unprocessed suppression reads and never treats unknown keys as unsuppressed", async () => {
    await put(pending("m1"));
    await put({ pk: "suppress", sk: "alarm-m1", until: new Date(Date.now() + 86_400_000).toISOString() });
    let attempts = 0;
    fault = async (command, send) => {
      if (command instanceof BatchGetCommand && attempts++ === 0) return { Responses: { [table]: [] }, UnprocessedKeys: command.input.RequestItems };
      return send();
    };
    await scheduled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await read("pending", "m1")).toBeUndefined();
    await put(pending("m2"));
    fault = async (command, send) => command instanceof BatchGetCommand ? { UnprocessedKeys: command.input.RequestItems } : send();
    await expect(scheduled()).rejects.toThrow(/remain unprocessed/);
    expect(await read("pending", "m2")).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("delivers a large buffer across bounded payloads without dropping unseen alerts", async () => {
    for (let i = 0; i < 40; i++) await put(pending(`m${i}`, { reason: "r".repeat(1000), rawMessage: JSON.stringify({ AlarmDescription: "d".repeat(1000), NewStateReason: "r".repeat(1000) }) }));
    await scheduled();
    const firstMessage = JSON.parse(fetchMock.mock.calls[0]![1].body).text;
    const presented = (firstMessage.match(/^--- Alert /gm) ?? []).length;
    expect(presented).toBeLessThan(40);
    expect((await all()).filter(item => item.pk === "pending")).toHaveLength(40 - presented);
    for (let attempt = 0; attempt < 5 && (await all()).some(item => item.pk === "pending"); attempt++) {
      const state = await read("mapping", "state");
      await put({ ...state, status: "MERGED", lastSessionStartedAt: new Date(Date.now() - 3_600_000).toISOString() });
      await scheduled();
    }
    const records = await all();
    const deliveries = records.filter(item => item.pk === "delivery");
    for (const delivery of deliveries) expect(delivery.message).toBeUndefined();
    expect(records.some(item => item.pk === "pending")).toBe(false);
    const ids = deliveries.flatMap(item => item.messageIds);
    expect(ids).toHaveLength(40); expect(new Set(ids).size).toBe(40);
    for (const call of fetchMock.mock.calls) expect(Buffer.byteLength(JSON.parse(call[1].body).text)).toBeLessThanOrEqual(60_000);
  });

  it("quarantines a single oversized alert durably while dispatching its small neighbor", async () => {
    await put(pending("large", { rawMessage: "x".repeat(90_000) })); await put(pending("small"));
    await scheduled();
    expect((await read("quarantine", "large"))!.alert.rawMessage).toHaveLength(90_000);
    expect(await read("pending", "large")).toBeUndefined();
    expect((await read("mapping", "state"))!.alarmNames).toEqual(["alarm-small"]);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body).text).toContain("alarm-small");
  });

  it("isolates malformed JSON null from valid records in the same batch", async () => {
    const input = event(); input.Records.unshift({ ...input.Records[0]!, messageId: "bad", body: JSON.stringify({ Message: "null", TopicArn: topic }) });
    expect((await dispatch(input))?.batchItemFailures).toEqual([{ itemIdentifier: "bad" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await read("dedupe", "m1")).toBeDefined();
  });

  it("stores suppression work with terminal state and repairs it on webhook redelivery", async () => {
    await put(active()); let fail = true;
    fault = async (command, send) => {
      if (command instanceof UpdateCommand && command.input.Key?.pk === "suppress" && fail) { fail = false; throw new Error("injected suppression failure"); }
      return send();
    };
    await expect(callApi(webhook, mergeEvent())).rejects.toThrow(/injected/);
    expect((await read("mapping", "state"))!.status).toBe("MERGED");
    expect((await read("mapping", "state"))!.suppressionPending).toBeDefined();
    expect((await callApi(webhook, mergeEvent())).statusCode).toBe(202);
    expect((await read("mapping", "state"))!.suppressionPending).toBeUndefined();
    expect((await read("suppress", "alarm-1"))!.reason).toBe("merged");
  });

  it("also repairs suppression on a scheduled flush and preserves stronger windows", async () => {
    await put(active());
    const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await put({ pk: "suppress", sk: "alarm-1", until, reason: "known-issue" });
    fault = async (command, send) => { if (command instanceof UpdateCommand && command.input.Key?.pk === "suppress") throw new Error("injected failure"); return send(); };
    await expect(callApi(webhook, mergeEvent())).rejects.toThrow(); fault = undefined;
    await scheduled();
    expect((await read("mapping", "state"))!.suppressionPending).toBeUndefined();
    expect((await read("suppress", "alarm-1"))!.until).toBe(until);
  });

  it("replays a partially completed suppression outbox without extending its deadline", async () => {
    await put(active()); let fail = true;
    fault = async (command, send) => {
      if (command instanceof UpdateCommand && command.input.UpdateExpression === "REMOVE suppressionPending" && fail) { fail = false; throw new Error("lost outbox acknowledgement"); }
      return send();
    };
    await expect(callApi(webhook, mergeEvent())).rejects.toThrow();
    const deadline = (await read("suppress", "alarm-1"))!.until;
    await callApi(webhook, mergeEvent());
    expect((await read("mapping", "state"))!.suppressionPending).toBeUndefined();
    expect((await read("suppress", "alarm-1"))!.until).toBe(deadline);
  });

  it("replays more than a transaction's worth of terminal suppression work", async () => {
    const alarmNames = Array.from({ length: 125 }, (_, index) => `alarm-${index}`);
    await put({ ...active(), alarmNames });
    expect((await callApi(webhook, mergeEvent())).statusCode).toBe(200);
    expect((await all()).filter(item => item.pk === "suppress")).toHaveLength(125);
    expect((await read("mapping", "state"))!.suppressionPending).toBeUndefined();
  }, 10_000);

  it("rejects stale registration revisions and accepts an idempotent retry of the latest head", async () => {
    await put(active());
    expect((await registration("b".repeat(40))).statusCode).toBe(200);
    expect((await registration(sha)).statusCode).toBe(409);
    expect((await registration("b".repeat(40))).statusCode).toBe(200);
    expect((await read("mapping", "state"))!.prHeadSha).toBe("b".repeat(40));
    const response = await callApi(register, { headers: { authorization: `Bearer ${token}` }, requestContext: { http: { method: "GET" } }, queryStringParameters: { sessionId: "session_synthetic" } });
    expect(JSON.parse(response.body as string).revision).toBe(1);
  });

  it("makes the revision check atomic when another registration wins after the read", async () => {
    await put(active()); let injected = false;
    fault = async (command, send) => {
      if (command instanceof UpdateCommand && command.input.ExpressionAttributeValues?.[":next"] && !injected) {
        injected = true;
        await original.call(db, new UpdateCommand({ TableName: table, Key: { pk: "mapping", sk: "state" }, UpdateExpression: "SET prRegistrationRevision = :revision, prHeadSha = :sha", ExpressionAttributeValues: { ":revision": 1, ":sha": "c".repeat(40) } }));
      }
      return send();
    };
    expect((await registration("b".repeat(40))).statusCode).toBe(409);
    expect((await read("mapping", "state"))!.prHeadSha).toBe("c".repeat(40));
  });
});
