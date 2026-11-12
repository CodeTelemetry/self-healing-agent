import type { ScheduledEvent, SQSBatchResponse, SQSEvent } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { decodeSnsAlarm, planIncidentMessage, type NormalizedAlert } from "../domain/alerts.js";
import { readDelivery, type Delivery } from "../domain/delivery.js";
import { readBatchItems, writeBatches } from "../domain/dynamo-batches.js";
import { canStartSession, isSuppressed, nextBackoff, pruneStarts, withinBudget, type SessionState, type SuppressionRecord } from "../domain/session.js";
import { completeSuppression, extendSuppression } from "../domain/suppression.js";

const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
const table = () => process.env.STATE_TABLE_NAME!;
const stateKey = { pk: "mapping", sk: "state" };
const minutes = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return (Number.isFinite(value) && value > 0 ? value : fallback) * 60_000;
};
const cooldown = minutes("SESSION_COOLDOWN_MINUTES", 30);
const maxAge = minutes("SESSION_MAX_AGE_MINUTES", 360);
const budgetWindow = minutes("SESSION_BUDGET_WINDOW_MINUTES", 1440);
const budget = Number(process.env.SESSION_DAILY_BUDGET ?? 8);
const retention = 90 * 86_400;
const routineSchema = z.object({ url: z.string().url().refine(url => url.startsWith("https://api.anthropic.com/")), token: z.string().min(20) });
const sessionSchema = z.object({ claude_code_session_id: z.string().min(1), claude_code_session_url: z.string().url() });
let routine: { value: z.infer<typeof routineSchema>; loaded: number } | undefined;
class RoutineRejectedError extends Error { override name = "RoutineRejectedError"; }

async function getState(): Promise<SessionState | undefined> {
  return (await client.send(new GetCommand({ TableName: table(), Key: stateKey, ConsistentRead: true }))).Item as SessionState | undefined;
}

async function ingested(id: string): Promise<boolean> {
  return Boolean((await client.send(new GetCommand({ TableName: table(), Key: { pk: "dedupe", sk: id }, ConsistentRead: true }))).Item);
}

async function ingest(alert: NormalizedAlert): Promise<void> {
  if (await ingested(alert.messageId)) return;
  const now = Math.floor(Date.now() / 1000);
  try {
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: table(), Item: { pk: "dedupe", sk: alert.messageId, ingestedAt: new Date().toISOString(), expiresAt: now + 30 * 86_400 }, ConditionExpression: "attribute_not_exists(pk)" } },
      { Put: { TableName: table(), Item: { pk: "pending", sk: alert.messageId, alert, expiresAt: now + 7 * 86_400 } } },
    ] }));
  } catch (error) {
    // A duplicate or an uncertain transaction response is safe only once the
    // marker proves the entire atomic ingestion committed.
    if (!(await ingested(alert.messageId))) throw error;
  }
}

async function pending(): Promise<NormalizedAlert[]> {
  const alerts: NormalizedAlert[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const result = await client.send(new QueryCommand({
      TableName: table(), KeyConditionExpression: "pk = :pending", ExpressionAttributeValues: { ":pending": "pending" },
      ConsistentRead: true, Limit: Math.min(100, 200 - alerts.length), ...(cursor ? { ExclusiveStartKey: cursor } : {}),
    }));
    for (const item of result.Items ?? []) if (item.alert) alerts.push(item.alert as NormalizedAlert);
    cursor = result.LastEvaluatedKey;
  } while (cursor && alerts.length < 200);
  return alerts;
}

const clearPending = (ids: string[]) => writeBatches(client, table(), ids.map(sk => ({ DeleteRequest: { Key: { pk: "pending", sk } } })));

async function routineConfiguration() {
  if (!routine || Date.now() - routine.loaded > 60_000) {
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.ROUTINE_SECRET_ARN }));
    routine = { value: routineSchema.parse(JSON.parse(secret.SecretString ?? "{}")), loaded: Date.now() };
  }
  return routine.value;
}

async function fire(message: string, config: z.infer<typeof routineSchema>) {
  const result = await fetch(config.url, {
    method: "POST", headers: { authorization: `Bearer ${config.token}`, "anthropic-version": "2023-06-01", "anthropic-beta": "experimental-cc-routine-2026-04-01", "content-type": "application/json" },
    body: JSON.stringify({ text: message }), signal: AbortSignal.timeout(30_000),
  });
  if (!result.ok) {
    if ([400, 401, 403, 404, 413, 415, 422, 429].includes(result.status)) throw new RoutineRejectedError(`Routine rejected request with HTTP ${result.status}`);
    throw new Error(`Routine outcome uncertain after HTTP ${result.status}`);
  }
  const value = sessionSchema.parse(await result.json());
  return { sessionId: value.claude_code_session_id, sessionUrl: value.claude_code_session_url };
}

function continuity(state: SessionState | undefined): string {
  return state?.prUrl ? `\nPrior incident PR: ${state.prUrl}. Check for overlapping work before opening a duplicate.\n` : "";
}

async function reserve(delivery: Delivery, state: SessionState | undefined): Promise<void> {
  await client.send(new TransactWriteCommand({ TransactItems: [
    { Put: {
      TableName: table(), Item: delivery,
      ConditionExpression: "attribute_not_exists(pk) OR #phase = :rejected",
      ExpressionAttributeNames: { "#phase": "phase" }, ExpressionAttributeValues: { ":rejected": "REJECTED" },
    } },
    { Update: {
      TableName: table(), Key: stateKey,
      UpdateExpression: "SET repository = :repo, generation = if_not_exists(generation, :zero), updatedAt = :now, pendingDeliveryId = :id",
      ConditionExpression: state
        ? "generation = :generation AND attribute_not_exists(pendingDeliveryId) AND attribute_not_exists(suppressionPending)" + (state.sessionId ? " AND sessionId = :previous" : " AND attribute_not_exists(sessionId)") + (state.status ? " AND #status = :status" : "")
        : "attribute_not_exists(pk)",
      ...(state?.status ? { ExpressionAttributeNames: { "#status": "status" } } : {}),
      ExpressionAttributeValues: { ":repo": process.env.REPOSITORY, ":zero": 0, ":now": delivery.preparedAt, ":id": delivery.sk,
        ...(state ? { ":generation": state.generation, ...(state.sessionId ? { ":previous": state.sessionId } : {}), ...(state.status ? { ":status": state.status } : {}) } : {}) },
    } },
  ] }));
}

async function cleanup(delivery: Delivery): Promise<void> {
  for (const record of delivery.backoffs) await extendSuppression(client, table(), record);
  await clearPending(delivery.messageIds);
  await client.send(new TransactWriteCommand({ TransactItems: [
    { Update: { TableName: table(), Key: { pk: "delivery", sk: delivery.sk }, UpdateExpression: "SET cleanedAt = :now", ConditionExpression: "#phase = :completed", ExpressionAttributeNames: { "#phase": "phase" }, ExpressionAttributeValues: { ":now": new Date().toISOString(), ":completed": "COMPLETED" } } },
    { Update: { TableName: table(), Key: stateKey, UpdateExpression: "REMOVE pendingDeliveryId", ConditionExpression: "pendingDeliveryId = :id", ExpressionAttributeValues: { ":id": delivery.sk } } },
  ] }));
}

async function resume(delivery: Delivery): Promise<void> {
  if (delivery.phase === "PREPARED") {
    if (!delivery.message) throw new Error("Prepared delivery has no request payload");
    const config = await routineConfiguration();
    const attemptedAt = new Date().toISOString();
    const elapsed = Date.parse(attemptedAt) - Date.parse(delivery.preparedAt);
    delivery.backoffs = delivery.backoffs.map(record => ({ ...record, lastSeen: attemptedAt, until: new Date(Date.parse(record.until) + elapsed).toISOString(), expiresAt: record.expiresAt + Math.floor(elapsed / 1000) }));
    await client.send(new UpdateCommand({
      TableName: table(), Key: { pk: "delivery", sk: delivery.sk },
      UpdateExpression: "SET #phase = :firing, attemptedAt = :at, backoffs = :backoffs", ConditionExpression: "#phase = :prepared",
      ExpressionAttributeNames: { "#phase": "phase" }, ExpressionAttributeValues: { ":firing": "FIRING", ":prepared": "PREPARED", ":at": attemptedAt, ":backoffs": delivery.backoffs },
    }));
    delivery.phase = "FIRING"; delivery.attemptedAt = attemptedAt;
    let session: { sessionId: string; sessionUrl: string };
    try { session = await fire(delivery.message, config); }
    catch (error) {
      if (error instanceof RoutineRejectedError) {
        await client.send(new TransactWriteCommand({ TransactItems: [
          { Update: { TableName: table(), Key: { pk: "delivery", sk: delivery.sk }, UpdateExpression: "SET #phase = :rejected, expiresAt = :ttl REMOVE #message", ConditionExpression: "#phase = :firing", ExpressionAttributeNames: { "#phase": "phase", "#message": "message" }, ExpressionAttributeValues: { ":rejected": "REJECTED", ":firing": "FIRING", ":ttl": Math.floor(Date.now() / 1000) + retention } } },
          { Update: { TableName: table(), Key: stateKey, UpdateExpression: "REMOVE pendingDeliveryId", ConditionExpression: "pendingDeliveryId = :id", ExpressionAttributeValues: { ":id": delivery.sk } } },
        ] }));
      } else console.error(JSON.stringify({ event: "incident_launch_uncertain", batchId: delivery.sk }));
      throw error;
    }
    await client.send(new UpdateCommand({
      TableName: table(), Key: { pk: "delivery", sk: delivery.sk }, UpdateExpression: "SET #phase = :launched, sessionId = :session, sessionUrl = :url REMOVE #message",
      ConditionExpression: "#phase = :firing OR (#phase = :launched AND sessionId = :session)",
      ExpressionAttributeNames: { "#phase": "phase", "#message": "message" }, ExpressionAttributeValues: { ":firing": "FIRING", ":launched": "LAUNCHED", ":session": session.sessionId, ":url": session.sessionUrl },
    }));
    Object.assign(delivery, session, { phase: "LAUNCHED" });
  }
  if (delivery.phase === "FIRING") {
    console.error(JSON.stringify({ event: "incident_launch_uncertain", batchId: delivery.sk }));
    throw new Error("Launch outcome requires operator reconciliation");
  }
  if (delivery.phase === "LAUNCHED") {
    const state = await getState();
    if (state?.suppressionPending) await completeSuppression(client, table(), state);
    if (!delivery.sessionId || !delivery.sessionUrl || !delivery.attemptedAt) throw new Error("Incomplete launch journal");
    const now = new Date().toISOString();
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Update: {
        TableName: table(), Key: stateKey,
        UpdateExpression: "SET repository = :repo, sessionId = :session, sessionUrl = :url, #status = :active, startedAt = :at, lastSessionStartedAt = :at, updatedAt = :now, lastBatchId = :id, alarmNames = :alarms, recentStarts = :starts, generation = generation + :one REMOVE prNumber, prUrl, prState, prHeadRef, prHeadSha, prRegistrationRevision, prEventUpdatedAt, prUpdatedAt, prEventOrder, mergedAt, discardedAt",
        ConditionExpression: "pendingDeliveryId = :id AND generation = :generation AND attribute_not_exists(suppressionPending)",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":repo": process.env.REPOSITORY, ":session": delivery.sessionId, ":url": delivery.sessionUrl, ":active": "ACTIVE", ":at": delivery.attemptedAt, ":now": now, ":id": delivery.sk, ":alarms": delivery.alarmNames, ":starts": [...pruneStarts(state?.recentStarts, Date.now(), budgetWindow), delivery.attemptedAt], ":one": 1, ":generation": delivery.expectedGeneration },
      } },
      { Update: { TableName: table(), Key: { pk: "delivery", sk: delivery.sk }, UpdateExpression: "SET #phase = :completed, expiresAt = :ttl", ConditionExpression: "#phase = :launched", ExpressionAttributeNames: { "#phase": "phase" }, ExpressionAttributeValues: { ":completed": "COMPLETED", ":launched": "LAUNCHED", ":ttl": Math.floor(Date.now() / 1000) + retention } } },
    ] }));
    delivery.phase = "COMPLETED";
  }
  if (delivery.phase !== "COMPLETED") throw new Error("Delivery record does not establish a completed launch");
  await cleanup(delivery);
}

async function maybeStartSession(): Promise<void> {
  let state = await getState();
  if (state?.suppressionPending) { await completeSuppression(client, table(), state); state = await getState(); }
  if (state?.pendingDeliveryId) {
    const delivery = await readDelivery(client, table(), state.pendingDeliveryId);
    if (!delivery) throw new Error("Missing launch journal; retain alerts and reconcile the reservation");
    await resume(delivery); return;
  }
  const now = Date.now();
  if (!canStartSession(state, now, cooldown, maxAge)) return;
  const alerts = await pending();
  const rows = await readBatchItems(client, table(), [...new Set(alerts.map(alert => alert.alarmName))].map(sk => ({ pk: "suppress", sk })));
  const suppressions = new Map(rows.map(row => [row.sk as string, row as unknown as SuppressionRecord]));
  const suppressed = alerts.filter(alert => isSuppressed(suppressions.get(alert.alarmName), now));
  await clearPending(suppressed.map(alert => alert.messageId));
  if (!withinBudget(state?.recentStarts, now, budgetWindow, budget)) return;
  const plan = planIncidentMessage(process.env.REPOSITORY!, alerts.filter(alert => !isSuppressed(suppressions.get(alert.alarmName), now)), {
    extraGuidance: (process.env.INCIDENT_GUIDANCE ?? "").split("\n"), suffix: continuity(state),
  });
  for (const alert of plan.oversized) {
    await client.send(new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: table(), Item: { pk: "quarantine", sk: alert.messageId, alert, reason: "PAYLOAD_TOO_LARGE", quarantinedAt: new Date().toISOString(), expiresAt: Math.floor(now / 1000) + 7 * 86_400 } } },
      { Delete: { TableName: table(), Key: { pk: "pending", sk: alert.messageId } } },
    ] }));
    console.error(JSON.stringify({ event: "incident_alert_quarantined", messageId: alert.messageId }));
  }
  if (!plan.alerts.length) return;
  const previous = await readDelivery(client, table(), plan.batchId);
  if (previous && previous.phase !== "REJECTED") {
    if (previous.phase === "COMPLETED" && previous.cleanedAt) { await clearPending(previous.messageIds); return; }
    throw new Error("Unresolved delivery record; do not discard alerts or repeat the launch");
  }
  const alarmNames = [...new Set(plan.alerts.map(alert => alert.alarmName))];
  const delivery: Delivery = {
    pk: "delivery", sk: plan.batchId, phase: "PREPARED", messageIds: plan.alerts.map(alert => alert.messageId), alarmNames,
    message: plan.message, expectedGeneration: state?.generation ?? 0, preparedAt: new Date(now).toISOString(),
    backoffs: alarmNames.map(name => {
      const value = nextBackoff(suppressions.get(name), now, { baseMs: minutes("ALARM_BACKOFF_BASE_MINUTES", 120), maxMs: minutes("ALARM_BACKOFF_MAX_MINUTES", 1440), resetMs: minutes("ALARM_BACKOFF_RESET_MINUTES", 1440) });
      return { pk: "suppress", sk: name, until: new Date(value.until).toISOString(), strikes: value.strikes, lastSeen: new Date(now).toISOString(), reason: "backoff", expiresAt: Math.floor(value.until / 1000) + 86_400 };
    }),
  };
  await reserve(delivery, state);
  await resume(delivery);
  console.info(JSON.stringify({ event: "incident_session_started", batchId: delivery.sk, alertCount: delivery.messageIds.length }));
}

export async function handler(event: SQSEvent | ScheduledEvent): Promise<SQSBatchResponse | void> {
  if (!Array.isArray((event as SQSEvent).Records)) {
    try { await maybeStartSession(); }
    catch (error) { console.error(JSON.stringify({ event: "incident_flush_failed", errorType: error instanceof Error ? error.name : "unknown" })); throw error; }
    return;
  }
  const failures = new Set<string>();
  const accepted: string[] = [];
  const topics = new Set((process.env.SNS_TOPIC_ARNS ?? process.env.SNS_TOPIC_ARN ?? "").split(",").map(value => value.trim()).filter(Boolean));
  for (const record of (event as SQSEvent).Records) {
    const decoded = decodeSnsAlarm(record.body, record.messageId);
    if (decoded.kind === "invalid") { failures.add(record.messageId); continue; }
    if (decoded.kind !== "alarm" || (topics.size && !topics.has(decoded.alert.topicArn))) continue;
    accepted.push(record.messageId);
    try { await ingest(decoded.alert); }
    catch (error) {
      failures.add(record.messageId);
      console.error(JSON.stringify({ event: "incident_batch_failed", messageId: record.messageId, errorType: error instanceof Error ? error.name : "unknown" }));
    }
  }
  try { await maybeStartSession(); }
  catch (error) {
    accepted.forEach(id => failures.add(id));
    console.error(JSON.stringify({ event: "incident_batch_failed", errorType: error instanceof Error ? error.name : "unknown" }));
  }
  return { batchItemFailures: [...failures].map(itemIdentifier => ({ itemIdentifier })) };
}
