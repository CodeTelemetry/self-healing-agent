---
name: configure-cloud-environment
description: >-
  Set up or update a Claude Code cloud environment that gives an incident agent
  short-lived, read-only AWS credentials to a target account via this repo's
  credential broker, plus OTLP telemetry export. Use when onboarding a new
  self-healing-agent deployment, rotating its broker/ingest values, or when a
  cloud session cannot reach AWS or is missing telemetry. Triggers: "set up the
  self-healing cloud environment", "configure the claude.ai environment with
  read-only AWS access", "the incident agent can't call AWS", "rebuild the
  self-healing env block".
---

# Configure the self-healing cloud environment

This skill configures a **personal Claude Code cloud environment** so that an
incident session can (a) read the target AWS account with **1-hour, read-only**
credentials and (b) export telemetry over OTLP with content capture off by default. It encodes the one manual
part of a `self-healing-agent` deployment — creating the environment in
claude.ai — plus the AWS-side verification.

Nothing here is deployment-specific. Supply the account, region, stage, and
telemetry values for the deployment you are configuring.

## How the read-only access works (don't skip)

The environment holds **no IAM key**. It holds a broker URL and a revocable
bearer token. At run time an AWS `credential_process` (installed by the setup
script) calls the broker, which returns **1-hour STS credentials for an
explicit CloudWatch diagnostics role** in the target account — no
create/update/delete. So "the environment has read-only IAM access" means
"the environment can mint short-lived read-only STS sessions on demand."

The broker and role are created by this repo's `FoundationStack` (deploy it
first, once per account/region).

## Inputs you need

- **Environment name** — e.g. `<product>-self-healing-agent`.
- **FoundationStack outputs** for the target account/region:
  - `BrokerUrl`
  - `BrokerTokenSecretArn`
- **Authenticated AWS deployment profile** for that account; prefer short-lived operator credentials.
- **Telemetry** for this deployment:
  - `OTLP_ENDPOINT` (an OTLP/HTTP collector base URL)
  - `OTLP_BEARER_TOKEN` (a dedicated, revocable ingest key)
  - `OTEL_RESOURCE_ATTRIBUTES` (keep native repository/session identity; e.g. `env=<name>,deployment.environment=claude-cloud,self_healing.mapping_id=<mapping-id>`)

For a mapping, also supply its `PrRegistrationUrl` and `PrRegistrationSecretArn` outputs and set `PR_REGISTRATION_URL` / `PR_REGISTRATION_SECRET_ARN` when rendering. Set `SELF_HEALING_MAPPING_ID` and `SELF_HEALING_STAGE` for accurate attribution. The routine must register its PR/head using the installed helper after opening the PR and after each push, before merge.

## Step 1 — gather the broker outputs

From wherever the stacks are deployed, with the target
account's profile:

```bash
export AWS_PROFILE=<admin-profile-for-account>
STACK="SelfHealingFoundation-<stage>"
aws cloudformation describe-stacks --region <region> --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='BrokerUrl' || OutputKey=='BrokerTokenSecretArn'].[OutputKey,OutputValue]" \
  --output text
```

## Step 2 — render the environment-variable block

Run this repo's renderer. It reads the broker token from Secrets Manager and
prints the full block; **no secret is written to disk**:

```bash
export AWS_PROFILE=<admin-profile-for-account>
export BROKER_URL='<BrokerUrl from step 1>'
export BROKER_TOKEN_SECRET_ARN='<BrokerTokenSecretArn from step 1>'
export OTEL_EXPORTER_OTLP_ENDPOINT='<OTLP_ENDPOINT>'
export OTEL_EXPORTER_OTLP_BEARER_TOKEN='<dedicated ingest key>'
export OTEL_RESOURCE_ATTRIBUTES='env=<name>,deployment.environment=claude-cloud,self_healing.mapping_id=<mapping-id>'
export AWS_REGION='<region>'
pnpm render:claude-env
```

Keep the output only as long as you need it to paste into claude.ai — it
contains the broker token and the ingest key.

## Step 3 — create or update the claude.ai environment

This is **web-UI only**; use the available browser tools or have the operator enter the prepared values. In the in-app Browser pane or Claude-in-Chrome:

1. Go to `https://claude.ai/code`.
2. Open the environment selector (the cloud-environment dropdown next to the
   repository picker) → **Add cloud environment** (or open an existing one to
   update it).
3. **Name**: the environment name above.
4. **Network access**: **Custom**.
5. **Allowed domains**: enable **"Also include default list of common package
   managers"**, then add:
   - the host of your `OTLP_ENDPOINT` (e.g. `ingest.example.com`)
   - `*.amazonaws.com`
   - `*.api.aws`
6. **Setup script**: paste the contents of [`config/claude-cloud-setup.sh`](../../../config/claude-cloud-setup.sh).
7. **Environment variables**: paste the block from Step 2.
8. Save (**Add environment** / **Save**).

Notes:
- `form_input` may reject the disabled/empty domains box until network access is
  actually switched to Custom; click Custom first, then fill the fields.
- The environment values are visible to anyone who can use or edit this personal
  environment. Use dedicated, revocable tokens.

## Step 4 — verify the read-only access

Start a fresh cloud session in the configured environment and run:

```bash
aws sts get-caller-identity
aws cloudwatch describe-alarms --max-records 1 --query 'length(MetricAlarms)'
```

The identity must match the intended account and stage-specific diagnostics
role. Do not print environment values or credential-process output. Log reads
require explicit `diagnosticLogGroupArns`; metrics/alarm reads are the default.
The foundation's scheduled canary verifies the broker/AWS path independently.

Confirm telemetry arrives with the selected `env` and native session/repository
identity. Content/raw-body capture is opt-in under the target's data policy.
Keep missing evidence failing at the PR gate and verify association on a trial PR.

## After this

Creating the environment does not arm the agent. Separately: create the
API-triggered routine on this environment, store the routine secret
(`configure:mapping-secrets`), register the webhook (`configure:github-webhook`),
and set `dispatchEnabled: true`. The controller holds no Claude OAuth token — it
only fires the routine.
