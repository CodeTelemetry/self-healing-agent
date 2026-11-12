import { GetCommand, TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { SuppressionRecord } from "./session.js";

export interface Delivery {
  pk: "delivery";
  sk: string;
  phase: "PREPARED" | "FIRING" | "LAUNCHED" | "COMPLETED" | "REJECTED";
  messageIds: string[];
  alarmNames: string[];
  message?: string;
  backoffs: SuppressionRecord[];
  expectedGeneration: number;
  preparedAt: string;
  attemptedAt?: string;
  sessionId?: string;
  sessionUrl?: string;
  cleanedAt?: string;
}

export async function readDelivery(client: DynamoDBDocumentClient, table: string, id: string): Promise<Delivery | undefined> {
  return (await client.send(new GetCommand({ TableName: table, Key: { pk: "delivery", sk: id }, ConsistentRead: true }))).Item as Delivery | undefined;
}

export const recoveredSession = z.object({
  sessionId: z.string().regex(/^(session_|cse_)[A-Za-z0-9_-]{1,200}$/),
  sessionUrl: z.string().url(),
}).refine(value => {
  const url = new URL(value.sessionUrl);
  return url.protocol === "https:" && url.hostname === "claude.ai" && !url.username && !url.password &&
    url.pathname.replace(/^\/code\/cse_/, "/code/session_") === `/code/${value.sessionId.replace(/^cse_/, "session_")}` && !url.search && !url.hash;
}, "Recovery URL must identify the verified native cloud session");

// Explicit operator reconciliation. Neither outcome is inferred from a timeout.
export async function reconcileDelivery(client: DynamoDBDocumentClient, table: string, id: string, outcome: { sessionId: string; sessionUrl: string } | "not-started") {
  const session = outcome === "not-started" ? undefined : recoveredSession.parse(outcome);
  await client.send(new TransactWriteCommand({ TransactItems: [
    { ConditionCheck: { TableName: table, Key: { pk: "mapping", sk: "state" }, ConditionExpression: "pendingDeliveryId = :id", ExpressionAttributeValues: { ":id": id } } },
    { Update: {
      TableName: table, Key: { pk: "delivery", sk: id },
      UpdateExpression: session ? "SET #phase = :next, sessionId = :session, sessionUrl = :url REMOVE #message" : "SET #phase = :next REMOVE attemptedAt",
      ConditionExpression: "#phase = :firing",
      ExpressionAttributeNames: { "#phase": "phase", ...(session ? { "#message": "message" } : {}) },
      ExpressionAttributeValues: { ":next": session ? "LAUNCHED" : "PREPARED", ":firing": "FIRING", ...(session ? { ":session": session.sessionId, ":url": session.sessionUrl } : {}) },
    } },
  ] }));
}
