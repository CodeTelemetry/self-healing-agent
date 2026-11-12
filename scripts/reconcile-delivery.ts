import { parseArgs } from "node:util";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { reconcileDelivery } from "../src/domain/delivery.js";

const { values } = parseArgs({ options: {
  table: { type: "string" }, "batch-id": { type: "string" }, "session-id": { type: "string" }, "session-url": { type: "string" }, "confirm-not-started": { type: "boolean" },
} });
if (!values.table || !values["batch-id"] ||
    (values["confirm-not-started"] ? Boolean(values["session-id"] || values["session-url"]) : !values["session-id"] || !values["session-url"])) {
  throw new Error("Pass --table TABLE --batch-id ID and either verified --session-id / --session-url or --confirm-not-started after independently checking the routine history");
}
const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const state = (await client.send(new GetCommand({ TableName: values.table, Key: { pk: "mapping", sk: "state" }, ConsistentRead: true }))).Item;
if (state?.pendingDeliveryId !== values["batch-id"]) throw new Error("Batch is not the mapping's current launch reservation");
await reconcileDelivery(client, values.table, values["batch-id"], values["confirm-not-started"] ? "not-started" : { sessionId: values["session-id"]!, sessionUrl: values["session-url"]! });
process.stdout.write("Launch outcome recorded. The next scheduled flush will resume recovery.\n");
