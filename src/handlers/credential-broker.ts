import { createHash, timingSafeEqual } from "node:crypto";
import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { z } from "zod";

const secrets = new SecretsManagerClient({});
const sts = new STSClient({});
let cachedBrokerToken: string | undefined;
let cachedBrokerTokenAt = 0;

const brokerSecretSchema = z.object({ token: z.string().min(32) });

function response(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}

async function brokerToken(): Promise<string> {
  if (cachedBrokerToken && Date.now() - cachedBrokerTokenAt < 60_000) return cachedBrokerToken;
  const result = await secrets.send(
    new GetSecretValueCommand({ SecretId: process.env.BROKER_TOKEN_SECRET_ARN }),
  );
  const parsed = brokerSecretSchema.parse(JSON.parse(result.SecretString ?? "{}"));
  cachedBrokerToken = parsed.token;
  cachedBrokerTokenAt = Date.now();
  return parsed.token;
}

function authorized(provided: string | undefined, expected: string): boolean {
  if (!provided?.startsWith("Bearer ")) return false;
  const candidate = Buffer.from(provided.slice("Bearer ".length));
  const target = Buffer.from(expected);
  return candidate.length === target.length && timingSafeEqual(candidate, target);
}

function sessionIdentity(value: string | undefined): { roleSessionName: string; sourceIdentity: string; tag: string } {
  const raw = value && /^(session_|cse_)[A-Za-z0-9_-]+$/.test(value) ? value : "unknown-session";
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 20);
  const normalized = raw.replace(/[^A-Za-z0-9+=,.@_-]/g, "-");
  return {
    roleSessionName: `claude-${digest}`,
    sourceIdentity: normalized.slice(0, 64),
    tag: raw.slice(0, 256),
  };
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  try {
    const expected = await brokerToken();
    const authorization = event.headers.authorization ?? event.headers.Authorization;
    if (!authorized(authorization, expected)) {
      console.warn(JSON.stringify({ event: "broker_auth_denied" }));
      return response(401, { message: "Unauthorized" });
    }

    const identity = sessionIdentity(event.headers["x-claude-session"]);
    const assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: process.env.READ_ONLY_ROLE_ARN,
        RoleSessionName: identity.roleSessionName,
        SourceIdentity: identity.sourceIdentity,
        DurationSeconds: 3600,
        Tags: [{ Key: "ClaudeSession", Value: identity.tag }],
      }),
    );
    const credentials = assumed.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretAccessKey || !credentials.SessionToken || !credentials.Expiration) {
      throw new Error("STS returned incomplete credentials");
    }

    console.info(JSON.stringify({ event: "broker_credentials_issued", sourceIdentity: identity.sourceIdentity }));
    return response(200, {
      Version: 1,
      AccessKeyId: credentials.AccessKeyId,
      SecretAccessKey: credentials.SecretAccessKey,
      SessionToken: credentials.SessionToken,
      Expiration: credentials.Expiration.toISOString(),
    });
  } catch (error) {
    console.error(JSON.stringify({ event: "broker_error", errorType: error instanceof Error ? error.name : "unknown" }));
    throw new Error("Unable to issue credentials");
  }
};
