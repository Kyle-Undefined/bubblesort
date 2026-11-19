/**
 * Exercise Lakebed's production claimed-artifact pipeline from a public clone.
 *
 * Only allowlisted public source files are read. Private puzzle imports are
 * supplied in a MemorySourceStore using invented fixtures. All build output
 * stays in an isolated temporary directory; nothing is deployed.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaimedArtifact, validateAnonymousDeployPayload } from "lakebed/anonymous";
import { MemorySourceStore } from "lakebed/source-store";
import { CALENDAR, REPOS } from "./fixtures/puzzle-data.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const sources = new Map<string, string>();
const publicFiles = ["server/index.ts", "client/index.tsx", "favicon.svg"];
for (const entry of await readdir(join(root, "shared"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".ts")) publicFiles.push(`shared/${entry.name}`);
}
for (const path of publicFiles) sources.set(path, await readFile(join(root, path), "utf8"));

// The extra calendar field is a harmless leak canary in this in-memory build
// only. If the future calendar ever enters the browser bundle, it is detectable
// independently of minification or coincidental occurrences of its numbers.
const calendarCanary = "bubblesort-private-calendar-build-fixture";
const syntheticCalendar = CALENDAR.map((day) => ({ ...day, buildFixtureCanary: calendarCanary }));
sources.set("server/data/repos.gen.ts", `export const REPOS = ${JSON.stringify(REPOS)};\n`);
sources.set("server/data/calendar.gen.ts", `export const CALENDAR = ${JSON.stringify(syntheticCalendar)};\n`);
const sourceStore = new MemorySourceStore(sources);
const temporaryDirectory = await mkdtemp(join(tmpdir(), "bubblesort-build-"));
const originalDirectory = process.cwd();

console.log("Building the production claimed artifact with synthetic puzzle fixtures.");
console.log("This does not validate or modify canonical puzzle data, contact a host, or deploy.");

try {
  // Lakebed captures its build-output root when the CLI module first loads.
  // Load it after changing cwd so even its .lakebed files stay isolated.
  process.chdir(temporaryDirectory);
  const { buildCapsule } = await import("lakebed/cli");
  const built = await buildCapsule({
    capsuleDir: temporaryDirectory,
    capsuleId: "public-production-check",
    sourceStore,
    mode: "production"
  });

  // Match the SDK's buildClaimedEnvelope options. This second step runs source
  // diagnostics and artifact validation that production buildCapsule omits.
  const envelope = await createClaimedArtifact({
    app: built.app,
    clientOut: built.clientOut,
    clientStyles: built.clientStyles,
    serverInputs: built.serverInputs,
    serverOut: built.serverOut,
    sourceStore,
    tools: built.tools
  });
  const validated = validateAnonymousDeployPayload(envelope, { allowClaimedSource: true });
  const { artifact } = envelope;

  assert.equal(artifact.name, "Bubblesort");
  assert.equal(artifact.deployTarget, "claimed-source");
  assert.deepEqual(Object.keys(artifact.server.schema).sort(), ["results", "sessions"]);
  assert.deepEqual(Object.keys(artifact.server.queries).sort(), ["archive", "results", "today"]);
  assert.deepEqual(Object.keys(artifact.server.mutations), ["submit"]);
  assert.equal(artifact.server.auth.requireSignIn, false);
  assert.equal(Object.keys(built.env).length, 0);
  assert.equal(validated.artifactHash, envelope.artifactHash);

  const client = validated.clientBundle.toString("utf8");
  const server = Buffer.from(artifact.server.source.bundle, "base64").toString("utf8");
  // Confirm the canaries really reached the server before checking isolation.
  assert.ok(server.includes(calendarCanary), "The server build must contain its synthetic calendar.");
  for (const repo of REPOS) {
    assert.ok(server.includes(repo.slug), `The server build is missing ${repo.slug}.`);
    assert.ok(!client.includes(repo.slug), `Repository payload leaked to the client: ${repo.slug}.`);
  }
  assert.ok(!client.includes(calendarCanary), "Future calendar payload leaked to the client.");
  assert.ok(!client.includes("server/data/"), "A private data import entered the client bundle.");

  console.log(`Production artifact accepted by Lakebed ${artifact.createdWith.lakebed}.`);
  console.log("Verified sessions/results schema, game handlers, guest access, and client/server data isolation.");
} finally {
  process.chdir(originalDirectory);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
