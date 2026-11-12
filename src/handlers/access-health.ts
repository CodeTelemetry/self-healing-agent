import { CloudWatchClient, DescribeAlarmsCommand, PutMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { z } from "zod";

const secrets = new SecretsManagerClient({});
const metrics = new CloudWatchClient({});
const credentialsSchema = z.object({
  Version: z.literal(1),
  AccessKeyId: z.string().min(1),
  SecretAccessKey: z.string().min(1),
  SessionToken: z.string().min(1),
  Expiration: z.string().datetime(),
});

// Exercise the public broker and the permissions it actually issues, rather than
// testing with the monitor's own execution role. Never log credentials or tokens.
export async function handler(): Promise<void> {
  let healthy = 0;
  let step = "secret";
  try {
    const secret = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.BROKER_TOKEN_SECRET_ARN }));
    const { token } = z.object({ token: z.string().min(32) }).parse(JSON.parse(secret.SecretString ?? "{}"));
    step = "broker";
    const response = await fetch(process.env.BROKER_URL!, {
      headers: { Authorization: `Bearer ${token}`, "X-Claude-Session": "cse_access_health" },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Broker request failed");
    const result = credentialsSchema.parse(await response.json());
    if (Date.parse(result.Expiration) < Date.now() + 5 * 60_000) throw new Error("Credentials expire too soon");
    const credentials = { accessKeyId: result.AccessKeyId, secretAccessKey: result.SecretAccessKey, sessionToken: result.SessionToken };
    const config = { credentials, maxAttempts: 2, requestHandler: { requestTimeout: 10_000 } };
    step = "identity";
    const identity = await new STSClient(config).send(new GetCallerIdentityCommand({}));
    const role = process.env.READ_ONLY_ROLE_ARN!;
    const expectedArn = role.replace(":iam:", ":sts:").replace(":role/", ":assumed-role/") + "/";
    if (identity.Account !== role.split(":")[4] || !identity.Arn?.startsWith(expectedArn)) throw new Error("Unexpected identity");
    step = "cloudwatch";
    await new CloudWatchClient(config).send(new DescribeAlarmsCommand({ MaxRecords: 1 }));
    healthy = 1;
  } catch {
    // SDK and HTTP errors may contain request details; report only the failing step.
    console.error(JSON.stringify({ event: "access_health_failed", stage: process.env.STAGE, step }));
  }
  await metrics.send(new PutMetricDataCommand({
    Namespace: "SelfHealingAgent",
    MetricData: [{ MetricName: "ReadOnlyAccessHealthy", Dimensions: [{ Name: "Stage", Value: process.env.STAGE! }], Value: healthy, Unit: "Count" }],
  }));
  console.info(JSON.stringify({ event: "access_health_reported", stage: process.env.STAGE, healthy }));
}
