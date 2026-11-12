import { timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { normalizeSessionId } from "../domain/github.js";
import { isConditionalConflict, registrationSchema } from "../domain/pr-registration.js";
import type { SessionState } from "../domain/session.js";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
let cached: { token: string; at: number } | undefined;
const response = (statusCode: number, body: unknown) => ({
  statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body),
});

export const handler: APIGatewayProxyHandlerV2 = async event => {
  if (Buffer.byteLength(event.body ?? "") > 12_000) return response(413, { message: "Payload too large" });
  if (!cached || Date.now() - cached.at > 60_000) {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.PR_REGISTRATION_SECRET_ARN }));
    cached = { token: z.object({ token: z.string().min(32) }).parse(JSON.parse(result.SecretString ?? "{}")).token, at: Date.now() };
  }
  const supplied = event.headers.authorization ?? event.headers.Authorization;
  const candidate = Buffer.from(supplied?.startsWith("Bearer ") ? supplied.slice(7) : "");
  const expected = Buffer.from(cached.token);
  if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) return response(401, { message: "Unauthorized" });
  const method = event.requestContext?.http?.method ?? "POST";
  let value: unknown;
  try { value = method === "GET" ? { sessionId: event.queryStringParameters?.sessionId } : JSON.parse(event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : event.body ?? ""); }
  catch { return response(400, { message: "Invalid JSON" }); }
  const parsed = (method === "GET" ? registrationSchema.pick({ sessionId: true }) : registrationSchema).safeParse(value);
  if (!parsed.success) return response(400, { message: "Invalid registration" });
  const registration = parsed.data;
  const current = await documentClient.send(new GetCommand({
    TableName: process.env.STATE_TABLE_NAME, Key: { pk: "mapping", sk: "state" }, ConsistentRead: true,
  }));
  const state = current.Item as SessionState | undefined;
  if (!state?.sessionId || !Number.isInteger(state.generation) || state.status === "MERGED" || state.status === "DISCARDED" ||
      normalizeSessionId(state.sessionId) !== normalizeSessionId(registration.sessionId)) {
    return response(409, { message: "Session is not the active incident" });
  }
  const revision = state.prRegistrationRevision ?? 0;
  if (method === "GET") return response(200, { revision });
  const update = registrationSchema.parse(registration);
  if (state.prHeadRef && (state.prNumber !== update.pullRequestNumber || state.prHeadRef !== update.headRef)) {
    return response(409, { message: "Incident already registered to another PR or branch" });
  }
  if (state.prHeadSha === update.headSha) return response(200, { registered: true, revision });
  if (update.expectedRevision !== revision) return response(409, { message: "Registration changed; rerun the helper against the current checkout" });
  try {
    await documentClient.send(new UpdateCommand({
      TableName: process.env.STATE_TABLE_NAME, Key: { pk: "mapping", sk: "state" },
      UpdateExpression: "SET prNumber = :number, prUrl = :url, prHeadRef = :ref, prHeadSha = :sha, prRegistrationRevision = :next, #status = :open, prState = :openState, updatedAt = :now REMOVE prEventUpdatedAt, prEventOrder, prUpdatedAt",
      ConditionExpression: "sessionId = :session AND generation = :generation AND #status <> :merged AND #status <> :discarded AND (attribute_not_exists(prHeadRef) OR (prNumber = :number AND prHeadRef = :ref)) AND (attribute_not_exists(prRegistrationRevision) OR prRegistrationRevision = :expected)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":session": state.sessionId, ":generation": state.generation, ":merged": "MERGED", ":discarded": "DISCARDED", ":open": "PR_OPEN", ":openState": "OPEN",
        ":number": update.pullRequestNumber, ":ref": update.headRef, ":sha": update.headSha, ":expected": revision, ":next": revision + 1,
        ":url": `https://github.com/${process.env.REPOSITORY}/pull/${update.pullRequestNumber}`, ":now": new Date().toISOString(),
      },
    }));
  } catch (error) {
    if (isConditionalConflict(error)) return response(409, { message: "Incident changed; register again against the active session" });
    throw error;
  }
  return response(200, { registered: true, revision: revision + 1 });
};
