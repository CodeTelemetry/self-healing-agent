import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

it("registers the real checkout head with a freshly read revision without printing its capability", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "self-healing-helper-"));
  try {
    const setup = await readFile("config/claude-cloud-setup.sh", "utf8");
    const script = setup.split('cat > "$install_dir/register-pull-request" <<\'SCRIPT\'\n')[1]?.split("\nSCRIPT")[0];
    if (!script) throw new Error("Registration helper missing from cloud setup");
    const helper = path.join(root, "register-pull-request");
    await writeFile(helper, script); await chmod(helper, 0o755);
    await mkdir(path.join(root, "empty-template"));
    execFileSync("git", ["init", "--quiet", "--initial-branch=claude/incident", "--template", path.join(root, "empty-template"), root]);
    execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null", "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "--quiet", "--allow-empty", "-m", "Synthetic head"]);
    const sha = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const curl = path.join(root, "curl");
    await writeFile(curl, `#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
args=sys.argv[1:]
if '--get' in args:
 print(json.dumps(dict(revision=17)))
else:
 Path(os.environ['CAPTURE']).write_text(args[args.index('--data')+1])
 print(json.dumps(dict(registered=True)))
`); await chmod(curl, 0o755);
    const capability = "synthetic-capability-for-helper-tests";
    const output = execFileSync(helper, ["7"], { cwd: root, encoding: "utf8", env: {
      ...process.env, PATH: `${root}:${process.env.PATH}`, CAPTURE: path.join(root, "captured.json"),
      SELF_HEALING_PR_REGISTRATION_URL: "https://example.invalid/incidents/pr", SELF_HEALING_PR_REGISTRATION_TOKEN: capability,
      CLAUDE_CODE_REMOTE_SESSION_ID: "cse_synthetic",
    } });
    expect(JSON.parse(await readFile(path.join(root, "captured.json"), "utf8"))).toEqual({ sessionId: "cse_synthetic", pullRequestNumber: 7, headRef: "claude/incident", headSha: sha, expectedRevision: 17 });
    expect(output).not.toContain(capability);
  } finally { await rm(root, { recursive: true, force: true }); }
});
