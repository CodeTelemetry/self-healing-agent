import { execFileSync } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { callTool } from "@codetelemetry/mcp";
import { z } from "zod";
import { readContext } from "./workspace-context.js";
import { assertStrictGate, STRICT_GATE_POLICY } from "../src/domain/pr-gate.js";

const gateSchema = z.object({
  config: z.unknown(), actions: z.object({
    workflow: z.object({ path: z.literal(".github/workflows/codetelemetry-pr-gate.yml"), content: z.string().min(1) }),
    rulesetJson: z.string().min(1),
  }),
});

function requiredRuleset(value: unknown) {
  const ruleset = z.object({
    name: z.literal("CodeTelemetry PR gate"), target: z.literal("branch"), enforcement: z.literal("active"),
    bypass_actors: z.array(z.unknown()).max(0).optional(),
    conditions: z.object({ ref_name: z.object({ include: z.array(z.string()), exclude: z.array(z.string()).max(0) }) }),
    rules: z.array(z.object({ type: z.string(), parameters: z.unknown().optional() }).passthrough()),
  }).passthrough().parse(value);
  const status = ruleset.rules.find(rule => rule.type === "required_status_checks");
  const parameters = z.object({ required_status_checks: z.array(z.object({ context: z.string(), integration_id: z.number() })) }).parse(status?.parameters);
  if (!ruleset.conditions.ref_name.include.includes("~DEFAULT_BRANCH") ||
      !parameters.required_status_checks.some(check => check.context === "codetelemetry/validation" && check.integration_id === 15368)) {
    throw new Error("Ruleset must require the CodeTelemetry check from GitHub Actions on the default branch");
  }
  return ruleset;
}

export async function configurePrGate(repository: string, targetPath: string) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("repository must be OWNER/REPOSITORY");
  const target = await realpath(targetPath);
  const git = (...args: string[]) => execFileSync("git", ["-C", target, ...args], { encoding: "utf8" }).trim();
  if (git("rev-parse", "--show-toplevel") !== target) throw new Error("target-path must be the repository root");
  const remote = git("remote", "get-url", "origin").replace(/\.git$/, "");
  if (![ `https://github.com/${repository}`, `git@github.com:${repository}`, `ssh://git@github.com/${repository}` ].some(expected => expected.toLowerCase() === remote.toLowerCase())) {
    throw new Error("Target checkout origin does not match the selected GitHub repository");
  }
  const context = readContext();
  // Inspect the generated artifact and local destination before remote mutation.
  const before = await callTool("get_github_pr_gate", {}, context);
  if (!before.ok) throw new Error("Unable to inspect the workspace gate");
  const preview = gateSchema.parse(before.gate);
  requiredRuleset(JSON.parse(preview.actions.rulesetJson));
  for (const relative of [".github", ".github/workflows", preview.actions.workflow.path]) {
    try { if ((await lstat(path.join(target, relative))).isSymbolicLink()) throw new Error("Gate workflow path must not contain symlinks"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const destination = path.join(target, preview.actions.workflow.path);
  let existing: string | undefined;
  try { existing = await readFile(destination, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (existing !== undefined && existing !== preview.actions.workflow.content) throw new Error("Target workflow differs; reconcile it explicitly before rerunning");
  const installed = z.array(z.object({ id: z.number().int().positive(), name: z.string() })).parse(JSON.parse(execFileSync("gh", ["api", "--paginate", "--slurp", `repos/${repository}/rulesets`], { encoding: "utf8" })).flat());
  const own = installed.find(item => item.name === "CodeTelemetry PR gate");
  if (own) requiredRuleset(JSON.parse(execFileSync("gh", ["api", `repos/${repository}/rulesets/${own.id}`], { encoding: "utf8" })));
  // Explicit operator action. This never publishes a grader or pushes/merges code.
  const result = await callTool("configure_github_pr_gate", { ...STRICT_GATE_POLICY, addRepositories: [repository] }, context);
  if (!result.ok) throw new Error(`Gate setup failed: ${String(result.error)}`);
  const gate = gateSchema.parse(result.gate);
  assertStrictGate(gate.config);
  if (gate.actions.workflow.content !== preview.actions.workflow.content) throw new Error("Generated workflow changed during configuration; inspect it before rerunning");
  const ruleset = requiredRuleset(JSON.parse(gate.actions.rulesetJson));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, gate.actions.workflow.content, { mode: 0o644 });
  // Preserve existing rulesets and any additional protections within them.
  if (!own) execFileSync("gh", ["api", "--method", "POST", `repos/${repository}/rulesets`, "--input", "-"], {
    input: JSON.stringify(ruleset), stdio: ["pipe", "ignore", "inherit"],
  });
  process.stdout.write("Strict gate policy and required-check ruleset configured. Review and commit the generated target workflow to its default branch, then verify the check runs.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { repository: { type: "string" }, "target-path": { type: "string" } } });
  if (!values.repository || !values["target-path"]) throw new Error("Pass --repository OWNER/REPOSITORY and --target-path /path/to/that/checkout");
  await configurePrGate(values.repository, values["target-path"]);
}
