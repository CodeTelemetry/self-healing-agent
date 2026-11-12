#!/usr/bin/env bash
set -euo pipefail

install_dir=/opt/self-healing-agent
mkdir -p "$install_dir"

if ! command -v aws >/dev/null 2>&1; then
  architecture="$(uname -m)"
  case "$architecture" in
    x86_64) aws_arch=x86_64 ;;
    aarch64|arm64) aws_arch=aarch64 ;;
    *) echo "Unsupported architecture: $architecture" >&2; exit 1 ;;
  esac
  temporary_dir="$(mktemp -d)"
  trap 'rm -rf "$temporary_dir"' EXIT
  curl --fail --silent --show-error \
    "https://awscli.amazonaws.com/awscli-exe-linux-${aws_arch}.zip" \
    --output "$temporary_dir/awscliv2.zip"
  unzip -q "$temporary_dir/awscliv2.zip" -d "$temporary_dir"
  "$temporary_dir/aws/install" --update
fi

cat > "$install_dir/aws-credential-process" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
: "${AWS_READONLY_BROKER_URL:?AWS_READONLY_BROKER_URL is required}"
: "${AWS_READONLY_BROKER_TOKEN:?AWS_READONLY_BROKER_TOKEN is required}"
session_id="${CLAUDE_CODE_REMOTE_SESSION_ID:-unknown-session}"
exec curl --fail --silent --show-error \
  --header "Authorization: Bearer ${AWS_READONLY_BROKER_TOKEN}" \
  --header "X-Claude-Session: ${session_id}" \
  "${AWS_READONLY_BROKER_URL}"
SCRIPT
chmod 0755 "$install_dir/aws-credential-process"

cat > "$install_dir/aws-config" <<'CONFIG'
[profile self-healing-readonly]
credential_process = /opt/self-healing-agent/aws-credential-process
region = us-east-1
output = json
CONFIG
chmod 0644 "$install_dir/aws-config"

# Dedicated mapping capability pins the current checkout's PR/head. Tokens are
# consumed from the environment, never written to a file or included in JSON.
cat > "$install_dir/register-pull-request" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
: "${SELF_HEALING_PR_REGISTRATION_URL:?PR registration URL is required}"
: "${SELF_HEALING_PR_REGISTRATION_TOKEN:?PR registration token is required}"
: "${CLAUDE_CODE_REMOTE_SESSION_ID:?Cloud session ID is required}"
pr_number="${1:?Usage: register-pull-request PR_NUMBER}"
revision="$(curl --fail --silent --show-error --max-time 20 --get \
  --header "Authorization: Bearer ${SELF_HEALING_PR_REGISTRATION_TOKEN}" \
  --data-urlencode "sessionId=${CLAUDE_CODE_REMOTE_SESSION_ID}" \
  "$SELF_HEALING_PR_REGISTRATION_URL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["revision"])')"
head_ref="$(git symbolic-ref --quiet --short HEAD)"
head_sha="$(git rev-parse HEAD)"
payload="$(python3 -c 'import json,sys; print(json.dumps(dict(sessionId=sys.argv[1],pullRequestNumber=int(sys.argv[2]),headRef=sys.argv[3],headSha=sys.argv[4],expectedRevision=int(sys.argv[5]))))' "$CLAUDE_CODE_REMOTE_SESSION_ID" "$pr_number" "$head_ref" "$head_sha" "$revision")"
curl --fail --silent --show-error --max-time 20 \
  --header "Authorization: Bearer ${SELF_HEALING_PR_REGISTRATION_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data "$payload" "$SELF_HEALING_PR_REGISTRATION_URL"
SCRIPT
chmod 0755 "$install_dir/register-pull-request"
