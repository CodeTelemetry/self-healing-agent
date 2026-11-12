import { PutSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const client = new SecretsManagerClient({ region: process.env.AWS_REGION ?? "us-east-1" });
await client.send(
  new PutSecretValueCommand({
    SecretId: required("ROUTINE_SECRET_ARN"),
    SecretString: JSON.stringify({
      url: required("CLAUDE_ROUTINE_URL"),
      token: required("CLAUDE_ROUTINE_TOKEN"),
    }),
  }),
);
process.stdout.write("Routine secret updated.\n");
