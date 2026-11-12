import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";
import { telemetryConfiguration } from "../src/domain/telemetry.js";
import { captureConfiguration } from "../src/domain/capture.js";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const region = process.env.AWS_REGION ?? "us-east-1";
const telemetry = telemetryConfiguration({
  environment: process.env.CODETELEMETRY_ENVIRONMENT ?? process.env.OTEL_RESOURCE_ATTRIBUTES?.split(",").find(attribute => attribute.startsWith("env="))?.slice(4),
  mappingId: process.env.SELF_HEALING_MAPPING_ID,
  stage: process.env.SELF_HEALING_STAGE,
});
const ingestKey = process.env.OTEL_EXPORTER_OTLP_BEARER_TOKEN ?? required("CODETELEMETRY_INGEST_KEY");
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "https://ingest.codetelemetry.com";
if (new URL(endpoint).protocol !== "https:") throw new Error("OTLP endpoint must use HTTPS");
const attributes = new Map<string, string>();
for (const item of (process.env.OTEL_RESOURCE_ATTRIBUTES ?? "").split(",").filter(Boolean)) {
  const separator = item.indexOf("=");
  if (separator < 1 || /[\r\n]/.test(item)) throw new Error("Resource attributes must be key=value pairs");
  const key = item.slice(0, separator);
  if (["project.path", "session.id"].includes(key)) throw new Error("Keep native repository and session identity; do not override it with resource attributes");
  attributes.set(key, item.slice(separator + 1));
}
for (const item of telemetry.resourceAttributes.split(",")) {
  const separator = item.indexOf("=");
  attributes.set(item.slice(0, separator), item.slice(separator + 1));
}
const brokerUrl = required("BROKER_URL");
const capture = captureConfiguration({ content: process.env.CODETELEMETRY_CAPTURE_CONTENT === "1", rawApiBodies: process.env.CODETELEMETRY_CAPTURE_RAW_API_BODIES === "1" });
const registrationUrl = process.env.PR_REGISTRATION_URL;
const registrationSecretArn = process.env.PR_REGISTRATION_SECRET_ARN;
if (Boolean(registrationUrl) !== Boolean(registrationSecretArn)) throw new Error("PR_REGISTRATION_URL and PR_REGISTRATION_SECRET_ARN must be supplied together");
if (registrationUrl && new URL(registrationUrl).protocol !== "https:") throw new Error("PR registration URL must use HTTPS");
const client = new SecretsManagerClient({ region });
const secret = await client.send(
  new GetSecretValueCommand({ SecretId: required("BROKER_TOKEN_SECRET_ARN") }),
);
const brokerToken = z.object({ token: z.string().min(32) }).parse(JSON.parse(secret.SecretString ?? "{}"));
let registrationToken: string | undefined;
if (registrationUrl && registrationSecretArn) {
  const result = await client.send(new GetSecretValueCommand({ SecretId: registrationSecretArn }));
  registrationToken = z.object({ token: z.string().min(32) }).parse(JSON.parse(result.SecretString ?? "{}")).token;
}

process.stdout.write(
  [
    "CLAUDE_CODE_ENABLE_TELEMETRY=1",
    "OTEL_LOGS_EXPORTER=otlp",
    "OTEL_METRICS_EXPORTER=otlp",
    "OTEL_TRACES_EXPORTER=otlp",
    "OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
    `OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
    `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${ingestKey}`,
    `OTEL_RESOURCE_ATTRIBUTES=${[...attributes].map(([key, value]) => `${key}=${value}`).join(",")}`,
    ...Object.entries(capture).map(([key, value]) => `${key}=${value}`),
    "OTEL_METRICS_INCLUDE_SESSION_ID=true",
    "OTEL_METRICS_INCLUDE_VERSION=true",
    "OTEL_METRICS_INCLUDE_ACCOUNT_UUID=true",
    "OTEL_METRICS_INCLUDE_ENTRYPOINT=true",
    "AWS_PROFILE=self-healing-readonly",
    "AWS_SDK_LOAD_CONFIG=1",
    "AWS_CONFIG_FILE=/opt/self-healing-agent/aws-config",
    `AWS_REGION=${region}`,
    `AWS_DEFAULT_REGION=${region}`,
    `AWS_READONLY_BROKER_URL=${brokerUrl}`,
    `AWS_READONLY_BROKER_TOKEN=${brokerToken.token}`,
    ...(registrationUrl && registrationToken ? [
      `SELF_HEALING_PR_REGISTRATION_URL=${registrationUrl}`,
      `SELF_HEALING_PR_REGISTRATION_TOKEN=${registrationToken}`,
    ] : []),
  ].join("\n") + "\n",
);
