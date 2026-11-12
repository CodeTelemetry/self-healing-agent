# Operations

Supply your deployment's stage and mapping ID. Resource names follow
`self-healing-agent-<stage>-<mappingId>`. Deploy in the SNS topics' Region.

## State model

One retained DynamoDB table holds six item kinds:

- `pk=mapping, sk=state`: session generation, PR lifecycle, recent starts, and
  any `pendingDeliveryId` or `suppressionPending` recovery work.
- `pk=pending, sk=<SNS MessageId>`: buffered normalized alerts; TTL 7 days.
- `pk=dedupe, sk=<SNS MessageId>`: ingestion markers; TTL 30 days.
- `pk=delivery, sk=<batch hash>`: durable launch journal. Unresolved records have
  no TTL; completed/rejected records expire after 90 days. Request text is removed
  after a session is durably recorded or the request is definitively rejected.
- `pk=suppress, sk=<AlarmName>`: per-alarm backoff and disposition suppression.
- `pk=quarantine, sk=<SNS MessageId>`: complete oversized alerts retained for
  operator inspection; TTL 7 days, with a CloudWatch alarm.

An ingestion transaction commits the pending alert and its dedupe marker
together. Malformed records are isolated in the SQS partial-batch response and
can reach the DLQ without blocking valid neighbors. Unprocessed batch operations
are retried; unknown suppression reads block dispatch.

The payload planner selects complete alert sections within a 60 KB text budget.
Only selected alerts receive delivery cleanup and backoff. Remaining alerts stay
buffered under the normal retention/suppression policy. An alert that cannot fit
alone is atomically moved to quarantine; other alerts can continue.

## Launch recovery

The journal advances through `PREPARED` → `FIRING` → `LAUNCHED` → `COMPLETED`.
The mapping reserves that delivery before the HTTP call. Once a returned native
session is recorded, mapping persistence and cleanup can resume without firing
the routine again. The reservation is released only after cleanup finishes.
Definite HTTP rejections retain alerts and release the slot for retry.

There is no assumed routine API idempotency guarantee. A connection failure
after possible acceptance leaves `FIRING`, retains pending alerts, and blocks
new launches. A process stopping between the `FIRING` write and HTTP call has
the same conservative outcome. Independently inspect routine history and match
the batch ID in its prompt before choosing either reconciliation outcome.

For an accepted session whose identity you have verified:

```bash
pnpm reconcile:delivery --table TABLE --batch-id BATCH_ID \
  --session-id session_VERIFIED --session-url https://claude.ai/code/session_VERIFIED
```

If independent verification proves no session started:

```bash
pnpm reconcile:delivery --table TABLE --batch-id BATCH_ID --confirm-not-started
```

The command uses operator AWS credentials, checks the current reservation and
phase atomically, and never infers failure from elapsed time. The next scheduled
flush resumes recovery. `LAUNCHED` retries mapping persistence; `COMPLETED` retries
cleanup without another routine request. Do not delete a reservation to bypass
reconciliation.

## PR lifecycle

The routine runs `/opt/self-healing-agent/register-pull-request PR_NUMBER` from
the PR branch after opening the PR and after each push, before merge. The helper
uses its mapping-specific capability to read a revision via authenticated
`GET /incidents/pr?sessionId=...`, then posts the current checkout head with
`expectedRevision`. A 409 requires rerunning the helper to reread both revision
and checkout; replaying old JSON is unsafe. Unchanged latest-head retries are
idempotent. Revisions protect ordering, not GitHub head attestation; the saved
capability remains trusted.

Only a signed webhook matching the registered repository/PR/branch/head can
advance the generation. An opened webhook may precede registration and be
ignored; registration itself sets `PR_OPEN`. Redeliver a merge that arrived
before registration of the final head. PR-body session links confer no authority.

`MERGED` is terminal. `DISCARDED` additionally requires closing the registered PR
with `<!-- self-healing-disposition: known-issue -->` in its body. An unmarked
close does not retire the generation. Terminal state and `suppressionPending`
outbox work commit together. Webhook redelivery and scheduled flushes replay the
work idempotently, preserving longer suppression windows. A new generation
waits for that work to finish.

## Gating and anti-flap

The dispatcher buffers rather than steering live sessions. A new session needs
a free slot and an elapsed cooldown. `ACTIVE`/`PR_OPEN` sessions older than
`sessionMaxAgeMinutes` are treated as abandoned; set this comfortably above the
longest expected investigation so a working session is not replaced.

Defaults: cooldown 30 minutes, maximum session age 360 minutes, and 8 starts per
rolling `sessionBudgetWindowMinutes` (1440). Over-budget alerts remain buffered.
Per-alarm backoff starts at 120 minutes, doubles to 1440, and resets after 1440
minutes of quiet. Matching merges suppress handled alarms for 240 minutes;
known-issue closes suppress them for 10080 minutes. These values are typed
`MappingStack` props. Suppression is monotonic: older retries cannot shorten a
stronger window.

The five-minute EventBridge flush shares the dispatcher's reserved concurrency
of 1 with SQS processing. Set `dispatchEnabled: false` and redeploy to disable
both triggers. Queued alerts retain their normal 14-day SQS retention; buffered
and quarantined alerts retain their 7-day TTL. Check in-flight work when pausing.

## Monitoring

Mapping alarms cover Lambda errors, DLQ depth, retryable batch failures,
`incident_launch_uncertain`, and `incident_alert_quarantined`. The latter log
events need operator action even when the Lambda returns a partial-batch result.
Route notifications to a separate operator topic rather than the incident topic
being consumed, to avoid a controller alarm loop.

Foundation alarms cover broker errors/authentication denials and a scheduled
broker → STS identity → CloudWatch read canary. The historical
`ReadOnlyAccessHealthy` metric and role names remain, but the role grants explicit
CloudWatch diagnostics; log access needs exact `diagnosticLogGroupArns`.
The canary verifies AWS access independently of the saved Claude environment.
Verify that environment with a new session running `aws sts get-caller-identity`
and `aws cloudwatch describe-alarms --max-records 1`. Never print credential
process output or environment secrets.

## Recovery and retention

- **DLQ:** inspect the failure and journal before redriving. Some messages may
  already be durably buffered; atomic dedupe prevents repeating ingestion.
- **Quarantine:** inspect the complete alert before its 7-day TTL expires.
  Correct or explicitly summarize the payload and publish a new valid SNS
  notification. The original message ID remains deduped.
- **Missed merge:** verify registered identity/head, register the final head if
  necessary, and redeliver. If the session is unavailable, an authorized operator
  must independently verify the target PR/head before repairing state.
- **Stuck generation:** inspect/reconcile `pendingDeliveryId` and
  `suppressionPending` before changing the state item.
- **Removal:** destroying a mapping removes its resources and SNS subscriptions;
  imported topics and other subscriptions remain. The state table is retained.

## Upgrading existing deployments

Deploy both stacks and update every dedicated saved environment's setup script
and registration URL/token. Head-changing registrations now require a revision.
Update the routine prompt and start a fresh session. Existing incidents must
register their correct PR/head; old body-link associations are not promoted.

Legacy delivery markers without a phase cannot prove launch completion. If one
blocks pending work, pause dispatch and independently verify routine history
before repairing that specific legacy state. The code does not reconstruct
alerts lost by an older implementation. Rebuild compiled library/handler assets
before deployment. Grader application/publication and target gate setup remain
separate operator actions.

## Rotation

Rotate broker and registration capabilities independently, re-render the saved
environment, and verify a fresh session. Lambda secret caches refresh within a
minute; issued STS credentials last until expiry unless revoked through IAM.
Verify telemetry with a replacement ingest key before revoking the old one.
Regenerate the routine token and rerun `configure:mapping-secrets`; rotate the
webhook secret and rerun `configure:github-webhook`. The controller stores no
Claude OAuth token.
