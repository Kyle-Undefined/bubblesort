/**
 * Run the existing server verification suite from a public checkout.
 *
 * Only the two private data imports are substituted, in memory, while bundling
 * the real tools/verify.ts and server/index.ts. No file under server/data is
 * read or written. Production verification remains `npm run verify`.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { dayIndexFrom, EPOCH_DAY } from "../shared/format.ts";
import { STAT_KEYS } from "../shared/types.ts";
import { CALENDAR } from "./fixtures/puzzle-data.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const privateModules = new Set([
  join(root, "server/data/calendar.gen.ts"),
  join(root, "server/data/repos.gen.ts")
]);
const fixture = join(root, "tools/fixtures/puzzle-data.ts");
const firstDay = Math.max(1, dayIndexFrom(Date.now()));

// A 20-day window contains a full ten-day stat bag, so every stat has a nearby
// representative day. Use noon UTC to keep each subprocess clear of rollover.
const representatives = STAT_KEYS.map((stat) => {
  const entry = CALENDAR.slice(firstDay, firstDay + 20).find((day) => day.stat === stat);
  if (!entry) throw new Error(`The synthetic calendar has no nearby ${stat} day.`);
  return { stat, nowMs: (EPOCH_DAY + entry.day) * 86_400_000 + 12 * 60 * 60 * 1_000 };
});

// This banner runs only inside each temporary child bundle. Preserve normal
// Date construction, parsing, UTC helpers, and call behavior while making both
// Date.now() and no-argument new Date() use the same representative game day.
const clock = `
const fixtureNow = Number(process.env.BUBBLESORT_FIXTURE_NOW);
if (!Number.isFinite(fixtureNow)) throw new Error("Missing fixture clock.");
const RealDate = globalThis.Date;
globalThis.Date = new Proxy(RealDate, {
  construct(target, args, newTarget) {
    return Reflect.construct(target, args.length ? args : [fixtureNow], newTarget);
  },
  apply() {
    return new RealDate(fixtureNow).toString();
  },
  get(target, property, receiver) {
    return property === "now" ? () => fixtureNow : Reflect.get(target, property, receiver);
  }
});
`;
const temporaryDirectory = await mkdtemp(join(tmpdir(), "bubblesort-verify-"));

console.log("Running the real server suite with synthetic puzzle fixtures.");
console.log("This does not validate or modify the canonical production calendar.");

try {
  const outfile = join(temporaryDirectory, "verify.mjs");
  await build({
    absWorkingDir: root,
    entryPoints: [join(root, "tools/verify.ts")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    banner: { js: clock },
    plugins: [{
      name: "synthetic-puzzle-data",
      setup(builder) {
        builder.onResolve({ filter: /(?:calendar|repos)\.gen\.ts$/ }, (args) => {
          if (privateModules.has(resolve(args.resolveDir, args.path))) {
            return { path: fixture };
          }
        });
        // Keep the installed Lakebed server implementation intact. An absolute
        // import lets the temporary bundle resolve the SDK from this checkout.
        builder.onResolve({ filter: /^lakebed\/server$/ }, () => ({
          path: import.meta.resolve("lakebed/server"),
          external: true
        }));
      }
    }]
  });

  // The suite calls process.exit on assertion failures. Run it separately so
  // the temporary directory is still removed when verification fails. Each
  // stat gets fresh module state, a fresh in-memory DB, and its own clock.
  let total = 0;
  let failed = 0;
  for (const { stat, nowMs } of representatives) {
    const result = spawnSync(process.execPath, [outfile], {
      cwd: root,
      env: { ...process.env, BUBBLESORT_FIXTURE_NOW: String(nowMs) },
      encoding: "utf8"
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Verification stopped by ${result.signal}.`);

    const count = result.stdout.match(/^(\d+) checks passed\.$/m);
    const date = new Date(nowMs).toISOString().slice(0, 10);
    if (result.status === 0 && count) {
      total += Number(count[1]);
      console.log(`  ${stat} (${date} UTC): ${count[0]}`);
    } else {
      failed++;
      console.error(`  ${stat} (${date} UTC): FAILED`);
      process.stderr.write(result.stdout);
      process.stderr.write(result.stderr);
    }
  }
  console.log(`${total} fixture assertions passed across ${STAT_KEYS.length} stat runs; ${failed} runs failed.`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
