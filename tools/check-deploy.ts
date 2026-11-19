// Validate the real production checkout before allowing a redeploy. This
// command builds locally; only `npm run deploy` subsequently contacts hosting.
import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const required = ["server/data/repos.gen.ts", "server/data/calendar.gen.ts", "lakebed.json"];
const missing: string[] = [];
for (const path of required) {
  try { await access(join(root, path)); } catch { missing.push(path); }
}
if (missing.length) {
  console.error(`Cannot redeploy: missing ${missing.join(", ")}.`);
  console.error("Use the original production checkout with its private puzzle files and deployment binding.");
  console.error("Public-clone checks are available with npm run verify:public. No files have been generated or deployed.");
  process.exit(1);
}

const binding = JSON.parse(await readFile(join(root, "lakebed.json"), "utf8"));
if (typeof binding.deployId !== "string" || !binding.deployId.trim()) {
  console.error("Cannot redeploy: lakebed.json must identify the existing deployment.");
  process.exit(1);
}

const verification = spawnSync(process.execPath, [join(root, "tools/verify.ts")], { cwd: root, stdio: "inherit" });
if (verification.error) throw verification.error;
if (verification.status !== 0) process.exit(verification.status ?? 1);

process.chdir(root);
const { runCli } = await import("lakebed/cli");
await runCli(["build", root, "--target", "claimed", "--json"]);
console.log("Production calendar verification and Lakebed build passed. Nothing has been deployed.");
