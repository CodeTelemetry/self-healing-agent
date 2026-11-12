import { UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { isConditionalConflict } from "./pr-registration.js";
import type { SessionState, SuppressionRecord } from "./session.js";

// Replaying an older transition must never shorten a newer suppression window.
export async function extendSuppression(client: DynamoDBDocumentClient, table: string, record: SuppressionRecord): Promise<void> {
  try {
    await client.send(new UpdateCommand({
      TableName: table, Key: { pk: record.pk, sk: record.sk },
      UpdateExpression: "SET #until = :until, strikes = :strikes, lastSeen = :seen, #reason = :reason, expiresAt = :ttl",
      ConditionExpression: "attribute_not_exists(#until) OR #until < :until",
      ExpressionAttributeNames: { "#until": "until", "#reason": "reason" },
      ExpressionAttributeValues: { ":until": record.until, ":strikes": record.strikes, ":seen": record.lastSeen, ":reason": record.reason, ":ttl": record.expiresAt },
    }));
  } catch (error) { if (!isConditionalConflict(error)) throw error; }
}

export async function completeSuppression(client: DynamoDBDocumentClient, table: string, state: SessionState): Promise<void> {
  const work = state.suppressionPending;
  if (!work) return;
  for (const name of work.alarmNames) {
    await extendSuppression(client, table, {
      pk: "suppress", sk: name, until: work.until, strikes: 1, lastSeen: work.transitionAt,
      reason: work.reason, expiresAt: Math.floor(Date.parse(work.until) / 1000) + 86_400,
    });
  }
  try {
    await client.send(new UpdateCommand({
      TableName: table, Key: { pk: "mapping", sk: "state" },
      UpdateExpression: "REMOVE suppressionPending",
      ConditionExpression: "generation = :generation AND suppressionPending.id = :id",
      ExpressionAttributeValues: { ":generation": state.generation, ":id": work.id },
    }));
  } catch (error) { if (!isConditionalConflict(error)) throw error; }
}
