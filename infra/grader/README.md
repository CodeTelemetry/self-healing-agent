# Self-healing session grader

This Terraform root manages six CodeTelemetry Grader draft checks. It is independent of the AWS CDK stacks: `pnpm synth` and `cdk deploy` do not apply it. The checks come from the incident workflow and verification commands in [the repo README](../../README.md), with stable `self-healing.*` IDs.

## Quick start

You need Terraform 1.5+ and a CodeTelemetry workspace. From the repository root:

```bash
pnpm install --frozen-lockfile
npx -y @codetelemetry/connect bootstrap my-workspace   # once, if you have no workspace context yet
export CODETELEMETRY_WORKSPACE=my-workspace
pnpm grader init
pnpm grader plan
pnpm grader apply
```

`pnpm grader <args>` runs `terraform -chdir=infra/grader <args>`. `init` installs the [CodeTelemetry provider](https://registry.terraform.io/providers/CodeTelemetry/codetelemetry/latest) from the Terraform Registry at the version recorded in `.terraform.lock.hcl`. To change the defaults, copy [terraform.tfvars.example](terraform.tfvars.example) to `terraform.tfvars`.

Applying saves a draft. Publish it separately, as described under [Authentication and apply](#authentication-and-apply).

## Checks

| Check | Weight | Successful recorded command |
| --- | ---: | --- |
| AWS identity | 5 | `aws sts get-caller-identity` |
| Alarm investigation | 5 | `aws cloudwatch describe-alarms` or `describe-alarm-history` |
| Incident evidence | 5 | `aws logs filter-log-events`, `get-log-events`, `get-query-results`, or `aws cloudwatch get-metric-data` / `get-metric-statistics` |
| Build | 19 | `npm`, `pnpm`, `yarn`, or `bun` running the `build` script |
| Tests | 51 | `npm`, `pnpm`, `yarn`, or `bun` running the `test` script |
| PR workflow | 15 | A selected create, update, or comment action, as configured below |

Each check awards its weight once and requires a successful result. Failed attempts, commands with unknown outcomes, printed command text, help, and CLI skeleton generation earn no credit. Build and test checks match the `build` / `test` package script run through npm, pnpm, yarn, or bun, using the same documented matcher fields CodeTelemetry's own check seeding produces. Help, dry-run, watch, list-only, skip, and optional-script flags are excluded. These two checks also set `beforePush`, so CodeTelemetry's separate test-before-push evaluation requires success in the final edit-to-push window. The ordinary weighted score and test-before-push result are separate; inspect both.

Tests carry 51 points so omitting them cannot reach even the historical 70-point gate threshold: the maximum is 49. The strict setup command below requires **100/100**, disables complexity discounts, fails missing scores, and requires the separate before-push result. Adapt the target's checks and independent CI together; agent-editable package scripts are not independent test attestations.

## PR action options

The existing `self-healing.pull-request` check awards **15 points once** for any selected successful action. The default enables all three alternatives:

| Option | CLI evidence | GitHub MCP evidence |
| --- | --- | --- |
| `create` | `gh pr create` | `create_pull_request` |
| `update` | `gh pr edit` | `update_pull_request` |
| `comment` | `gh pr comment` | No ambiguous generic issue/reaction or draft-review tools |

Restrict the alternatives without editing the policy templates:

```bash
export TF_VAR_pull_request_actions='["create", "update", "comment"]'
pnpm grader plan

# Example: only an actual PR-creation action qualifies.
export TF_VAR_pull_request_actions='["create"]'
```

Empty and unknown selections are refused by Terraform. The three `matcherRule.include.any` entries in `checks.json` form an ordered create/update/comment catalog, and `main.tf` selects from it in that order.

CLI matching requires `gh pr` with the action among its normalized arguments. Commands that also name another `gh pr` subcommand, such as `gh pr list --search create`, are excluded, as are help, dry-run, browser-only, and `--delete-last` variants. This is an exclusion list, not a positional match: backtest it against recorded sessions before relying on it. Repetition and performing multiple actions never increase the 15-point award.

`add_issue_comment` is deliberately excluded: the upstream GitHub MCP tool can act on issues or PRs and can add a reaction without writing a comment. The current grader fields do not establish that distinction or bind the operation to the incident's PR. Pending review comments are also excluded because they do not establish publication of feedback. Use the PR-specific CLI for comment evidence until a richer, target-bound detector is available. These checks still cannot prove that an update/comment is useful or targets the correct incident PR.

By default every check is scoped to the exact `env=self-healing-agent` tag emitted by [render-claude-env.ts](../../scripts/render-claude-env.ts). This identifies the self-healing workflow across target repositories; it does not identify this provisioning repository. Sessions with another or unknown environment are outside this scope. There is no machine-specific working-directory matcher. Set `TF_VAR_environment` to another self-healing environment tag if needed. Optional `TF_VAR_repository_id` must be copied from actual target-session metadata, not inferred from the provisioning checkout. Adapt build/test matchers to each target's actual verification commands; the defaults are conventional package scripts, not proof that the target defines them. Multiple environments in the same workspace should be combined under one resource/state owner with distinct IDs.

## Associating target runs with PR validation

There are two separate links:

1. **Session → grader checks:** the ingest key selects the CodeTelemetry workspace. The workspace's published policy scores the session, and each check's `environment` selects the exact telemetry `env` value. With `repository_id = null`, these checks can apply in any target repository using that environment tag. The repo that deployed the CDK stack is not the scored repo.
2. **Target PR → session:** CodeTelemetry locates sessions through recorded PR URL evidence, such as successful CLI or GitHub MCP PR results, and can also use supported repository/head-branch evidence. The PR gate then evaluates the located session(s) against the published policy. Custom resource tags do not create this association. Independently, this controller's authenticated registration pins the active session to its PR/branch/head, and the signed webhook tracks merge. PR-body session links confer no controller authority. Neither controller endpoint issues a grader verdict.

Keep the native session and repository identity emitted by Claude. Do not replace `project.path` or `session.id` with the provisioning checkout or a static mapping ID. Ensure the retained evidence includes the successful PR result or supported repository/head evidence. Capture defaults omit prompt/tool content and raw bodies. If the selected export does not retain enough evidence, the strict gate fails; enable content capture explicitly only under the target's data policy, and verify association on a trial PR. Raw API bodies are not required by this configuration.

The mapping stack outputs `CodeTelemetryEnvironment` and `CodeTelemetryResourceAttributes`. Configure its Claude environment with those values. The shared default looks like:

```dotenv
OTEL_RESOURCE_ATTRIBUTES=env=self-healing-agent,deployment.environment=claude-cloud,self_healing.mapping_id=payments,self_healing.stage=prod
```

`env` is the supported grader selector. `self_healing.mapping_id` and `self_healing.stage` are attribution tags for identifying the deployment; the current Grader schema does not select checks by arbitrary resource attributes. No additional per-run ID tag is needed: the native Claude session ID identifies the run. A dedicated Claude environment per mapping keeps static mapping attribution accurate.

For a mapping with different checks, pass `-c telemetryEnvironment=self-healing-prod-payments` when deploying the mapping, render that same `CODETELEMETRY_ENVIRONMENT`, and set `TF_VAR_environment` to that value. Include all intended check sets with distinct IDs in the workspace's single policy/state owner. Adding only a new attribution tag will not select a different policy.

PR validation requires setup in **each target repository**:

1. Apply this Terraform root to the same CodeTelemetry workspace receiving the run telemetry, then review and publish the draft.
2. Run the explicit operator setup command from this controller checkout, using the same named workspace and an authenticated `gh` account authorized to manage the target's rulesets:

   ```bash
   pnpm configure:pr-gate --repository OWNER/REPOSITORY --target-path /path/to/target-checkout
   ```

   It verifies the checkout's origin, refuses conflicting/symlinked workflows, configures `enabled=true`, `minScore=100`, `missingScore=fail`, `complexityAware=false`, and `requireTestBeforePush=true`, and verifies the returned policy. It writes the service-generated workflow locally and installs its GitHub Actions required-check ruleset on the default branch. Existing enforcing rulesets and additional protections are preserved; a conflicting or weakened same-name ruleset requires explicit reconciliation. The policy is workspace-wide and also affects other trusted repositories.
3. Review and commit the exact generated `.github/workflows/codetelemetry-pr-gate.yml` to the target's default branch. The workflow uses GitHub OIDC and does not check out PR code. Until it lands, the newly required check can block PRs.
4. Verify a trial PR runs `codetelemetry/validation`, links to the expected session/head, and blocks missing scores or failed before-push checks. Keep the target's independent build/test CI required as well.

Deploying this CDK stack, adding telemetry tags, or saving a Grader draft does not perform those GitHub setup steps. The gate runs for target PRs, not just sessions with the self-healing tag. For mixed human/agent repositories, the workspace's policy must also cover intended non-self-healing sessions; an environment-scoped check alone is not a gate trigger filter. The gate uses its missing-score policy if no applicable score exists.

## MCP and backtesting

The repository pins `@codetelemetry/mcp` **0.6.0**, the latest published npm version verified on 2026-11-10. [`.mcp.json`](../../.mcp.json) launches the lockfile-installed binary through `pnpm exec`, so a fresh project MCP process uses that version. This changes the repository configuration; an already running MCP process needs to be restarted by its client. This repository's test toolchain requires Node.js 22.13+ on supported even release lines (see `package.json`).

```bash
pnpm install --frozen-lockfile
```

The provider validates check shape during `terraform validate` and `plan`, and the CodeTelemetry API validates matcher semantics during `apply`; this repository has no separate check generator or evaluator.

Use the CodeTelemetry MCP tools to backtest a grader draft.

1. Apply the intended draft checks and read `get_grader_config` for the current draft revision and check IDs.
2. Call `backtest_grader_checks` with the target `repository`, `draftRevision`, and `checkIds`. Alternatively, backtest selected candidates from `discover_grader_checks` using `discoveryId` and `candidateIds`.
3. Poll `get_grader_run` with the returned `runId`, following result/summary cursors. Inspect per-session evidence and after-last-edit/before-push timing separately. Report partial/unknown evidence explicitly; do not infer success from missing telemetry.

Backtests require workspace access and recorded evidence. Keep session evidence and backtest results in the authorized workspace. Saving candidates is a separate `save_grader_draft` operation, and publishing a policy requires its own action.

## Provider setup

The provider is [`CodeTelemetry/codetelemetry`](https://registry.terraform.io/providers/CodeTelemetry/codetelemetry/latest) on the Terraform Registry. `versions.tf` allows any `0.x` release from 0.1, and the committed `.terraform.lock.hcl` pins the exact version and its checksums for Linux, macOS, and Windows on amd64 and arm64. `pnpm grader init` installs it; no Go toolchain or CLI configuration is needed.

To move to a newer provider release, run `pnpm grader init -upgrade`, then `pnpm grader providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_amd64 -platform=darwin_arm64 -platform=windows_amd64 -platform=windows_arm64`, and commit the updated lock file. The provider source is [CodeTelemetry/terraform-provider-codetelemetry](https://github.com/CodeTelemetry/terraform-provider-codetelemetry).

## Authentication and apply

Use an existing Connect/MCP named workspace bound to this repository, or select one with `CODETELEMETRY_WORKSPACE`. The provider discovers `.codetelemetry/workspace.json` in the repository ancestry and loads credentials from private per-user context storage. Bind/select the intended organization before applying; credentials and organization IDs are not hardcoded in this module. See the provider's [named organization context instructions](https://github.com/CodeTelemetry/terraform-provider-codetelemetry#named-organization-contexts).

Existing management-token automation can instead supply `CODETELEMETRY_ENDPOINT`, a current Cognito **ID token** in `CODETELEMETRY_TOKEN`, and `CODETELEMETRY_ORGANIZATION_ID` when managing an organization. A bare OTLP `cot_…` ingest key is not a replacement for a management token; named contexts handle their own Grader authentication. Never put credentials in Terraform files or check descriptions.

From the repository root, after selecting a workspace:

```bash
pnpm grader init
pnpm grader fmt -check
pnpm grader validate
pnpm grader plan
pnpm grader apply
```

`validate` checks the configuration and the shape of each check offline. `plan` and `apply` need a selected workspace; without one the provider reports an invalid workspace configuration. The CodeTelemetry API validates matcher semantics when `apply` saves the draft, so a clean plan does not guarantee the service accepts every matcher.

The resource owns only its six IDs and preserves unrelated draft checks. Identical existing checks can be adopted; conflicting IDs require deliberate import and plan review. Importing `codetelemetry_grader_config.self_healing` with ID `workspace` adopts the visible draft, so reconcile any unrelated adopted checks before applying. Use one state owner per CodeTelemetry workspace. The default local state is ignored by Git; configure your approved encrypted remote backend for shared operation. State and saved plans contain check definitions even when Terraform marks them sensitive.

Applying saves a draft. Review that draft and publish it separately through the CodeTelemetry Grader page or the `publish_grader_config` MCP tool to activate scoring. This root does not publish policies, configure a GitHub PR gate, or add an alert destination. Destroy removes its managed draft checks and leaves published policy versions intact.

## Validation boundaries

The grader verifies successful recorded actions. It cannot prove the returned STS account/role or credential lifetime, that queried logs concern the delivered alarm, that a query completed with useful data, that the code actually fixes the incident, or that PR creation targets the expected repository. It also does not establish untrusted-alert handling, Auto-fix activation, or PR/session linkage. Review those separately. The signed GitHub webhook remains responsible for matching the Claude session and retiring an incident after merge; a high score does not change that state machine.

Full command/result telemetry must arrive before evaluation. Missing environment metadata can leave a session unscored; an unscored session is not a validated session. The PR-workflow check accepts only the selected create/update/comment alternatives, not PR reads. AWS SDK calls and other MCP/API alternatives need explicit corresponding checks. A routine may investigate and close a no-change incident without PR activity; the default still scores the documented code-fix workflow.

The controller's registered head prevents unrelated signed webhooks from retiring an incident; the static PR-action matcher still cannot bind an update/comment to that incident or judge its usefulness. Independent target CI and review remain required. A passing weighted score alone does not establish release readiness or test-before-push verification.
