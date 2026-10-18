// Bundles each test/*.test.ts with esbuild, with "obsidian" swapped for a
// small shim, then runs them with Node's built-in test runner.
import esbuild from "esbuild";
import { readdirSync, rmSync } from "fs";
import { spawnSync } from "child_process";

const out = "test/.build";
const entries = readdirSync("test")
  .filter((f) => f.endsWith(".test.ts"))
  .map((f) => `test/${f}`);

rmSync(out, { recursive: true, force: true });
await esbuild.build({
  entryPoints: entries,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outdir: out,
  alias: { obsidian: "./test/obsidian-shim.ts" },
  logLevel: "warning",
});

const built = entries.map((f) => f.replace(/^test\//, `${out}/`).replace(/\.ts$/, ".js"));
const run = spawnSync(process.execPath, ["--test", ...built], { stdio: "inherit" });
process.exit(run.status ?? 1);
