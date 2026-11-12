import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STRICT_GATE_POLICY } from "../src/domain/pr-gate.js";

const mocks = vi.hoisted(() => ({ exec: vi.fn(), tool: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mocks.exec }));
vi.mock("@codetelemetry/mcp", () => ({ callTool: mocks.tool }));
vi.mock("../scripts/workspace-context.js", () => ({ readContext: () => ({}) }));
import { configurePrGate } from "../scripts/configure-pr-gate.js";

const ruleset = {
  name: "CodeTelemetry PR gate", target: "branch", enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "required_status_checks", parameters: { required_status_checks: [{ context: "codetelemetry/validation", integration_id: 15368 }] } }],
};
const workflow = { path: ".github/workflows/codetelemetry-pr-gate.yml", content: "# Synthetic generated workflow\n" };
const gate = { config: STRICT_GATE_POLICY, actions: { workflow, rulesetJson: JSON.stringify(ruleset) } };
let target: string;
beforeEach(async () => {
  vi.clearAllMocks();
  target = await mkdtemp(path.join(tmpdir(), "self-healing-target-"));
  mocks.tool.mockResolvedValue({ ok: true, gate });
  mocks.exec.mockImplementation((binary: string, args: string[]) => {
    if (binary === "git") return args.includes("--show-toplevel") ? target : "git@github.com:owner/target-repository.git";
    return "[]";
  });
});
afterEach(async () => { await rm(target, { recursive: true, force: true }); });

describe("explicit target gate setup", () => {
  it("refuses a different origin before workspace or GitHub changes", async () => {
    await expect(configurePrGate("other/repository", target)).rejects.toThrow(/origin/);
    expect(mocks.tool).not.toHaveBeenCalled();
  });
  it("preflights conflicting workflows before policy mutation", async () => {
    await mkdir(path.join(target, ".github/workflows"), { recursive: true });
    await writeFile(path.join(target, workflow.path), "existing workflow\n");
    await expect(configurePrGate("owner/target-repository", target)).rejects.toThrow(/differs/);
    expect(mocks.tool.mock.calls.map(call => call[0])).toEqual(["get_github_pr_gate"]);
    expect(await readFile(path.join(target, workflow.path), "utf8")).toBe("existing workflow\n");
  });
  it("refuses symlinked workflow paths", async () => {
    await symlink(tmpdir(), path.join(target, ".github"));
    await expect(configurePrGate("owner/target-repository", target)).rejects.toThrow(/symlink/);
    expect(mocks.tool).toHaveBeenCalledTimes(1);
  });
  it("configures strict policy and creates only its required-check ruleset", async () => {
    await configurePrGate("owner/target-repository", target);
    expect(mocks.tool.mock.calls[1]?.slice(0, 2)).toEqual(["configure_github_pr_gate", { ...STRICT_GATE_POLICY, addRepositories: ["owner/target-repository"] }]);
    expect(await readFile(path.join(target, workflow.path), "utf8")).toBe(workflow.content);
    const mutation = mocks.exec.mock.calls.find(call => call[1].includes("POST"));
    expect(mutation?.[1]).toEqual(["api", "--method", "POST", "repos/owner/target-repository/rulesets", "--input", "-"]);
    expect(JSON.parse(mutation?.[2].input)).toEqual(ruleset);
  });
  it("rejects a weakened policy response before writing or installing a check", async () => {
    mocks.tool.mockResolvedValueOnce({ ok: true, gate }).mockResolvedValueOnce({ ok: true, gate: { ...gate, config: { ...STRICT_GATE_POLICY, missingScore: "pass" } } });
    await expect(configurePrGate("owner/target-repository", target)).rejects.toThrow(/required/);
    expect(mocks.exec.mock.calls.some(call => call[1].includes("POST"))).toBe(false);
    await expect(readFile(path.join(target, workflow.path))).rejects.toThrow();
  });
  it("preserves an existing enforcing ruleset and its extra protections", async () => {
    mocks.exec.mockImplementation((binary: string, args: string[]) => {
      if (binary === "git") return args.includes("--show-toplevel") ? target : "https://github.com/owner/target-repository";
      return args.includes("--slurp") ? JSON.stringify([[{ id: 7, name: ruleset.name }]]) : JSON.stringify({ ...ruleset, rules: [...ruleset.rules, { type: "required_linear_history" }] });
    });
    await configurePrGate("owner/target-repository", target);
    expect(mocks.exec.mock.calls.filter(call => call[0] === "gh")).toHaveLength(2);
  });
  it("refuses an existing bypassable or disabled ruleset before policy mutation", async () => {
    mocks.exec.mockImplementation((binary: string, args: string[]) => {
      if (binary === "git") return args.includes("--show-toplevel") ? target : "https://github.com/owner/target-repository";
      return args.includes("--slurp") ? JSON.stringify([[{ id: 7, name: ruleset.name }]]) : JSON.stringify({ ...ruleset, enforcement: "disabled" });
    });
    await expect(configurePrGate("owner/target-repository", target)).rejects.toThrow();
    expect(mocks.tool).toHaveBeenCalledTimes(1);
  });
});
