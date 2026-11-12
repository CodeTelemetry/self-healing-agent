import { setTimeout as delay } from "node:timers/promises";
import { BatchGetCommand, BatchWriteCommand, type BatchWriteCommandInput, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

type Write = NonNullable<BatchWriteCommandInput["RequestItems"]>[string][number];
const attempts = 5;
const backoff = (attempt: number) => delay(25 * 2 ** attempt);

export async function writeBatches(client: DynamoDBDocumentClient, table: string, writes: Write[]): Promise<void> {
  for (let offset = 0; offset < writes.length; offset += 25) {
    let pending = writes.slice(offset, offset + 25);
    for (let attempt = 0; pending.length; attempt++) {
      const result = await client.send(new BatchWriteCommand({ RequestItems: { [table]: pending } }));
      pending = result.UnprocessedItems?.[table] ?? [];
      if (pending.length && attempt === attempts - 1) throw new Error("DynamoDB writes remain unprocessed");
      if (pending.length) await backoff(attempt);
    }
  }
}

export async function readBatchItems(client: DynamoDBDocumentClient, table: string, keys: Record<string, string>[]): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  for (let offset = 0; offset < keys.length; offset += 100) {
    let pending = keys.slice(offset, offset + 100);
    for (let attempt = 0; pending.length; attempt++) {
      const result = await client.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: pending, ConsistentRead: true } } }));
      items.push(...(result.Responses?.[table] ?? []));
      pending = (result.UnprocessedKeys?.[table]?.Keys ?? []) as Record<string, string>[];
      if (pending.length && attempt === attempts - 1) throw new Error("DynamoDB reads remain unprocessed");
      if (pending.length) await backoff(attempt);
    }
  }
  return items;
}
