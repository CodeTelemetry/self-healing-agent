# Releasing

The source destination is `CodeTelemetry/self-healing-agent` on GitHub. The
library name is `@codetelemetry/self-healing-agent`; `private: true` prevents npm
publication. GitHub source publication, npm publication, AWS deployment, and
CodeTelemetry policy publication are separate operations.

Validate a candidate from a clean checkout:

Start DynamoDB Local as described in [Contributing](../CONTRIBUTING.md) and set
`DYNAMODB_TEST_ENDPOINT=http://127.0.0.1:8000` so recovery tests run as they do in CI.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm audit --audit-level=low
pnpm build:all
git diff --exit-code -- dist
pnpm exec cdk synth --quiet
pnpm pack --pack-destination /tmp/self-healing-release
```

Review the packed file list. The package includes compiled library code,
JavaScript Lambda bundles, their Zod license notices, the setup script, and
source/dependency license notices. It should import and synthesize both stacks
from an independent consumer without build hooks. The source archive additionally
contains tests, docs, operator tooling, and grader IaC. The grader's Terraform
validation installs the provider from the Terraform Registry with `pnpm grader init`.

Use the reviewed commit for publication and verify the exact archive's contents
and checksum. Publish only that candidate branch and intended tags; do not push
unreviewed branches or repository history. Check the GitHub Actions result after
pushing and before announcing a release. Use the organization repository's
standard access and review settings.

The controller release does not activate dispatch in existing stacks, update a
saved Claude environment, or install/publish a target grader. Follow the
[operations migration instructions](operations.md#upgrading-existing-deployments)
for those explicit operator changes.
