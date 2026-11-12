import { copyFile, mkdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build } from "esbuild";

const root = process.cwd();
const require = createRequire(import.meta.url);
const zodLicense = path.join(path.dirname(require.resolve("zod/package.json")), "LICENSE");
const outputRoot = path.join(root, "dist", "lambdas");
const handlers = ["credential-broker", "access-health", "dispatcher", "github-webhook", "pr-registration"] as const;

await rm(outputRoot, { recursive: true, force: true });

for (const handler of handlers) {
  const output = path.join(outputRoot, handler);
  await mkdir(output, { recursive: true });
  await build({
    entryPoints: [path.join(root, "src", "handlers", `${handler}.ts`)],
    outfile: path.join(output, "index.js"),
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    minify: true,
    sourcemap: false,
    external: ["@aws-sdk/*"],
  });
  await copyFile(zodLicense, path.join(output, "LICENSE.zod"));
}

const dispatcherBytes = (await stat(path.join(outputRoot, "dispatcher", "index.js"))).size;
process.stdout.write(`Built Lambda assets; dispatcher is ${dispatcherBytes} bytes.\n`);
