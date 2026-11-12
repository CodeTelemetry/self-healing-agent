import { execFileSync } from "node:child_process";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { z } from "zod";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const repository = required("REPOSITORY");
const webhookUrl = required("GITHUB_WEBHOOK_URL");
const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-1" });
const result = await client.send(
  new GetSecretValueCommand({ SecretId: required("GITHUB_WEBHOOK_SECRET_ARN") }),
);
const { token } = z.object({ token: z.string().min(32) }).parse(JSON.parse(result.SecretString ?? "{}"));
const hooks = JSON.parse(execFileSync("gh", ["api", `repos/${repository}/hooks`], { encoding: "utf8" })) as Array<{
  id: number;
  config?: { url?: string };
}>;
const existing = hooks.find((hook) => hook.config?.url === webhookUrl);
const payload = JSON.stringify({
  name: "web",
  active: true,
  events: ["pull_request"],
  config: { url: webhookUrl, content_type: "json", secret: token, insecure_ssl: "0" },
});
const endpoint = existing ? `repos/${repository}/hooks/${existing.id}` : `repos/${repository}/hooks`;
execFileSync("gh", ["api", "--method", existing ? "PATCH" : "POST", endpoint, "--input", "-"], {
  input: payload,
  stdio: ["pipe", "inherit", "inherit"],
});
