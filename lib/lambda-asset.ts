import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

// Resolve a bundled Lambda asset directory whether this construct runs from the
// source tree (lib/ -> dist/lambdas) or from a published/installed package
// (dist/lib/ -> dist/lambdas). Keeps consumers from having to bundle the
// handlers themselves.
export function lambdaAsset(name: string): string {
  const candidates = [
    path.join(moduleDir, "..", "lambdas", name),
    path.join(moduleDir, "..", "dist", "lambdas", name),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}
