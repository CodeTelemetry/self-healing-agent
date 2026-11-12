#!/usr/bin/env node
// Generic example app: synthesizes the reusable stacks from CDK context only.
// It hardcodes no account, repository, topic, or product. Real deployments live
// in a separate private config repository that imports these stacks as a
// package; this entry point exists for the library's own synth and tests.
import { App } from "aws-cdk-lib";
import { FoundationStack, MappingStack } from "../lib/index.js";

const app = new App();
const stage = String(app.node.tryGetContext("stage") ?? "dev");
const account = app.node.tryGetContext("account") ?? process.env.CDK_DEFAULT_ACCOUNT;
if (account !== undefined && !/^\d{12}$/.test(String(account))) throw new Error("account must be a 12-digit AWS account ID");
const region = String(app.node.tryGetContext("region") ?? process.env.CDK_DEFAULT_REGION ?? "us-east-1");
const baseEnv = account ? { env: { account: String(account), region } } : {};
const logContext = app.node.tryGetContext("diagnosticLogGroupArns") ?? [];
const diagnosticLogGroupArns: unknown = typeof logContext === "string" ? JSON.parse(logContext) : logContext;
if (!Array.isArray(diagnosticLogGroupArns) || diagnosticLogGroupArns.some(value => typeof value !== "string")) throw new Error("diagnosticLogGroupArns must be a JSON array of explicit ARNs");

new FoundationStack(app, `SelfHealingFoundation-${stage}`, {
  stage,
  diagnosticLogGroupArns,
  ...baseEnv,
  description: "Shared short-lived AWS credential broker for Claude cloud incident agents",
});

const repository = app.node.tryGetContext("repository") as string | undefined;
const configuredTopicArns = app.node.tryGetContext("snsTopicArns") as string[] | string | undefined;
const dispatchEnabled = String(app.node.tryGetContext("dispatchEnabled") ?? "true") !== "false";
const cooldownContext = app.node.tryGetContext("sessionCooldownMinutes");
const maxAgeContext = app.node.tryGetContext("sessionMaxAgeMinutes");
const guidanceContext = app.node.tryGetContext("incidentGuidance") as string[] | string | undefined;
const toList = (value: string[] | string | undefined): string[] | undefined =>
  Array.isArray(value)
    ? value
    : value
      ? value.split("\n").map((entry) => entry.trim()).filter(Boolean)
      : undefined;
const snsTopicArns = toList(configuredTopicArns);
const incidentGuidance = toList(guidanceContext);

if ((repository && !snsTopicArns) || (!repository && snsTopicArns)) {
  throw new Error("repository and snsTopicArns must be supplied together");
}
if (repository && snsTopicArns) {
  const mappingId = String(
    app.node.tryGetContext("mappingId") ?? repository.replace(/[^A-Za-z0-9_.-]/g, "-").toLowerCase(),
  );
  const regions = new Set(snsTopicArns.map((topicArn) => topicArn.split(":")[3]).filter(Boolean));
  if (regions.size !== 1) throw new Error("all snsTopicArns must be in the same AWS Region");
  const arnRegion = [...regions][0];
  if (!arnRegion) throw new Error("Unable to determine Region from snsTopicArn");
  new MappingStack(app, `SelfHealingMapping-${stage}-${mappingId}`, {
    stage,
    mappingId,
    repository,
    snsTopicArns,
    telemetryEnvironment: String(app.node.tryGetContext("telemetryEnvironment") ?? "self-healing-agent"),
    dispatchEnabled,
    ...(cooldownContext !== undefined ? { sessionCooldownMinutes: Number(cooldownContext) } : {}),
    ...(maxAgeContext !== undefined ? { sessionMaxAgeMinutes: Number(maxAgeContext) } : {}),
    ...(incidentGuidance ? { incidentGuidance } : {}),
    ...(account ? { env: { account: String(account), region: arnRegion } } : {}),
    description: `Claude self-healing mapping for ${repository}`,
  });
}
