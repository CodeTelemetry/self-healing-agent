# Contributing

Use the Node.js release lines declared in `package.json` and pnpm 11.19.0.
Helper contract tests also require a Unix shell (or WSL), Git, Bash, and Python 3.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm build:all
pnpm audit --audit-level=low
```

Commit generated `dist/` changes with the source changes that produce them.
CI rebuilds the library/handlers and rejects drift. Keep tests synthetic and
independent of a live AWS deployment, CodeTelemetry workspace, or private
recordings.

Failure-recovery integration tests use DynamoDB Local with synthetic credentials
and mocked routine HTTP responses. GitHub CI runs them on every change. To run
them locally:

```bash
docker run --detach --rm --name self-healing-dynamodb-tests \
  --publish 127.0.0.1:8000:8000 \
  amazon/dynamodb-local@sha256:6ada631ec7aa5fc83446855eb17233e3dad184fec47477e8140c6c569cfe0c86
DYNAMODB_TEST_ENDPOINT=http://127.0.0.1:8000 pnpm test
docker stop self-healing-dynamodb-tests
```

Without `DYNAMODB_TEST_ENDPOINT`, those integration tests are explicitly skipped;
the offline unit tests still run. Use a disposable DynamoDB Local
endpoint: the suite creates and deletes its own synthetic table.

Describe the resulting behavior and relevant validation in pull requests.
Keep deployment identifiers, saved environment output, credentials, and recorded
session evidence outside the repository. Build/test commands do not grant
permission to deploy infrastructure, publish a grader, or alter a target's gate.
