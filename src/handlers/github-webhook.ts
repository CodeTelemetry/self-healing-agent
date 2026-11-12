import { createHmac, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { hasKnownIssueDisposition, pullRequestEventOrder, timingSafeSignatureHeader } from "../domain/github.js";
import { isConditionalConflict } from "../domain/pr-registration.js";
import type { SessionState } from "../domain/session.js";
import { completeSuppression } from "../domain/suppression.js";

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const secrets = new SecretsManagerClient({});
let cachedWebhookSecret: string | undefined;
let cachedWebhookSecretAt = 0;

const secretSchema = z.object({ token: z.string().min(32) });
const pullRequestSchema = z.object({
  action: z.string(),
  repository: z.object({ full_name: z.string() }),
  pull_request: z.object({
    number: z.number().int().positive(),
    html_url: z.string().url(),
    merged: z.boolean().optional(),
    state: z.enum(["open", "closed"]),
    body: z.string().nullable().optional(),
    merged_at: z.string().nullable().optional(),
    updated_at: z.string().datetime(),
    head: z.object({
      ref: z.string().min(1).max(255),
      sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
      repo: z.object({ full_name: z.string() }),
    }),
  }),
});

async function webhookSecret(): Promise<string> {
  if (cachedWebhookSecret && Date.now() - cachedWebhookSecretAt < 60_000) return cachedWebhookSecret;
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.GITHUB_WEBHOOK_SECRET_ARN }),
  );
  cachedWebhookSecret = secretSchema.parse(JSON.parse(result.SecretString ?? "{}")).token;
  cachedWebhookSecretAt = Date.now();
  return cachedWebhookSecret;
}

function response(statusCode: number, body: unknown) {
  return { statusCode, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

// Post-disposition suppression windows: after a matching PR merges (fix
// deploying) or is closed as a known issue, hold the alarm so it does not
// immediately re-open a duplicate incident.
const MERGED_SUPPRESS_MS =
  (Number(process.env.MERGED_SUPPRESSION_MINUTES) > 0 ? Number(process.env.MERGED_SUPPRESSION_MINUTES) : 240) * 60_000;
const KNOWN_ISSUE_SUPPRESS_MS =
  (Number(process.env.KNOWN_ISSUE_SUPPRESSION_MINUTES) > 0 ? Number(process.env.KNOWN_ISSUE_SUPPRESSION_MINUTES) : 7 * 24 * 60) * 60_000;

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (Buffer.byteLength(event.body ?? "") > 1_400_000) return response(413, { message: "Payload too large" });
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64")
    : Buffer.from(event.body ?? "", "utf8");
  const supplied = timingSafeSignatureHeader(event.headers["x-hub-signature-256"]);
  const secret = await webhookSecret();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  if (!supplied || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
    return response(401, { message: "Invalid signature" });
  }
  if (event.headers["x-github-event"] !== "pull_request") {
    return response(202, { ignored: true });
  }

  let value: unknown;
  try { value = JSON.parse(rawBody.toString("utf8")); } catch { return response(400, { message: "Invalid JSON" }); }
  const parsed = pullRequestSchema.safeParse(value);
  if (!parsed.success) return response(400, { message: "Invalid PR event" });
  const payload = parsed.data;
  if (payload.repository.full_name.toLowerCase() !== process.env.REPOSITORY!.toLowerCase()) {
    return response(202, { ignored: true });
  }

  const current = await documentClient.send(
    new GetCommand({
      TableName: process.env.STATE_TABLE_NAME,
      Key: { pk: "mapping", sk: "state" },
      ConsistentRead: true,
    }),
  );
  const state = current.Item as SessionState | undefined;
  const pr = payload.pull_request;
  const repository = process.env.REPOSITORY!;
  if (!state?.sessionId || !Number.isInteger(state.generation) ||
      state.prNumber !== pr.number || !state.prHeadRef || !state.prHeadSha ||
      state.prHeadRef !== pr.head.ref || state.prHeadSha !== pr.head.sha ||
      pr.head.repo.full_name.toLowerCase() !== repository.toLowerCase() ||
      pr.html_url.toLowerCase() !== `https://github.com/${repository}/pull/${pr.number}`.toLowerCase()) {
    return response(202, { ignored: true, reason: "PR does not match an active authenticated registration" });
  }
  if (state.status === "MERGED" || state.status === "DISCARDED") {
    await completeSuppression(documentClient, process.env.STATE_TABLE_NAME!, state);
    return response(202, { ignored: true, reason: "incident is terminal; pending suppression completed" });
  }
  if (!["opened", "reopened", "edited", "synchronize", "closed", "ready_for_review", "converted_to_draft", "labeled", "unlabeled"].includes(payload.action)) {
    return response(202, { ignored: true });
  }
  const merged = pr.state === "closed" && pr.merged === true;
  const knownIssue = !merged && pr.state === "closed" && hasKnownIssueDisposition(pr.body);
  const order = pullRequestEventOrder(pr.updated_at, payload.action, pr.state, merged);
  const eventUpdatedAt = new Date(pr.updated_at).toISOString();
  if ((state.prEventOrder && order <= state.prEventOrder) || (!state.prEventOrder && state.prEventUpdatedAt && eventUpdatedAt < state.prEventUpdatedAt)) {
    return response(202, { ignored: true, reason: "stale PR event" });
  }
  const now = new Date().toISOString();
  const prState = knownIssue ? "KNOWN_ISSUE" : pr.state === "closed" ? "CLOSED_UNMERGED" : "OPEN";
  const suppressionPending: SessionState["suppressionPending"] = merged || knownIssue ? {
    id: `${state.generation}:${order}`, alarmNames: [...new Set(state.alarmNames ?? [])],
    until: new Date(Date.parse(now) + (merged ? MERGED_SUPPRESS_MS : KNOWN_ISSUE_SUPPRESS_MS)).toISOString(),
    transitionAt: now, reason: merged ? "merged" : "known-issue",
  } : undefined;
  try { await documentClient.send(
    new UpdateCommand({
      TableName: process.env.STATE_TABLE_NAME,
      Key: { pk: "mapping", sk: "state" },
      UpdateExpression:
        "SET #status = :status, prState = :prState, updatedAt = :now, prEventUpdatedAt = :eventAt, prEventOrder = :order" + (merged ? ", mergedAt = :mergedAt" : knownIssue ? ", discardedAt = :now" : "") + (suppressionPending ? ", suppressionPending = :work" : ""),
      ConditionExpression: "sessionId = :sessionId AND generation = :generation AND prNumber = :number AND prHeadRef = :ref AND prHeadSha = :sha AND #status <> :terminal AND #status <> :discarded AND (attribute_not_exists(prEventOrder) OR prEventOrder < :order)",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":status": merged ? "MERGED" : knownIssue ? "DISCARDED" : "PR_OPEN", ":terminal": "MERGED", ":discarded": "DISCARDED",
        ":number": pr.number, ":ref": pr.head.ref, ":sha": pr.head.sha,
        ":prState": merged ? "MERGED" : prState,
        ":now": now,
        ":sessionId": state.sessionId,
        ":generation": state.generation, ":eventAt": eventUpdatedAt, ":order": order,
        ...(merged ? { ":mergedAt": pr.merged_at ?? now } : {}),
        ...(suppressionPending ? { ":work": suppressionPending } : {}),
      },
    }),
  ); } catch (error) {
    if (isConditionalConflict(error)) return response(202, { ignored: true, reason: "incident changed or event was already processed" });
    throw error;
  }
  if (suppressionPending) await completeSuppression(documentClient, process.env.STATE_TABLE_NAME!, { ...state, suppressionPending });
  if (merged) console.info(JSON.stringify({ event: "incident_pr_merged", sessionId: state.sessionId, generation: state.generation, prNumber: pr.number }));
  return response(200, merged ? { merged: true } : { tracked: true, prState });
};
