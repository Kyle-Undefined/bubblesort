/**
 * Turn the raw API cache into the committed dataset module.
 *
 *   node tools/build-dataset.ts
 *
 * Reads data/raw/repo/*.json, applies data/denylist.txt, sanity-checks every
 * stat, and writes server/data/repos.gen.ts.
 *
 * The dataset ships as a .ts module rather than a .json file on purpose:
 * lakebed limits static capsule assets to the favicon, so there is nothing for
 * the server to read at runtime. It has to be compiled in.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Repo } from "../shared/types.ts";
import { STAT_KEYS, hasStat } from "../shared/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const REPO_DIR = path.join(ROOT, "data", "raw", "repo");
const DENYLIST = path.join(ROOT, "data", "denylist.txt");
const OUT = path.join(ROOT, "server", "data", "repos.gen.ts");

/** Plausibility bounds. Anything outside these is bad data, not a surprising repo. */
const MIN_STARS = 20_000;
const MAX_COMMITS = 5_000_000;
/**
 * Git did not exist before 2005 and neither did most of this, but repos do
 * carry deliberately backdated commits — golang/go opens with a 1972 "hello,
 * world" attributed to Kernighan. A floor here turns that into a missing age
 * stat rather than a puzzle claiming Go is older than C.
 */
const MIN_FIRST_COMMIT = Date.parse("1990-01-01");

/**
 * How many repos survive into the dataset, best-known first.
 *
 * The pool goes down to 20k stars, but recognition falls off a cliff well
 * before that — and a puzzle is only fair if a player has some prior about all
 * five repos in it. One repo nobody has heard of turns the whole board into a
 * coin flip. Cutting here puts the floor around 36k stars.
 */
const MAX_REPOS = 700;

interface RawRepo {
  slug: string;
  lang: string | null;
  stars: number;
  openIssues: number;
  fork: boolean;
  archived: boolean;
  commits: number | null;
  contributors: number | null;
  firstCommitMs: number | null;
  error?: string;
}

// ---------------------------------------------------------------- denylist

async function loadDenylist(): Promise<{ patterns: RegExp[]; raw: string[] }> {
  const text = await readFile(DENYLIST, "utf8");
  const raw = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));

  const patterns = raw.map((line) => {
    const escaped = line.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`, "i");
  });

  return { patterns, raw };
}

// ---------------------------------------------------------------- main

async function main() {
  const { patterns, raw: patternText } = await loadDenylist();

  const files = (await readdir(REPO_DIR)).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    console.error("no raw repos found. run: GITHUB_TOKEN=$(gh auth token) node tools/fetch-repos.ts");
    process.exit(1);
  }

  const cutByDenylist: string[] = [];
  const cutByData: string[] = [];
  const kept: Repo[] = [];
  const missing: Record<string, string[]> = {};

  for (const file of files) {
    const r = JSON.parse(await readFile(path.join(REPO_DIR, file), "utf8")) as RawRepo;

    const hit = patterns.findIndex((p) => p.test(r.slug));
    if (hit !== -1) {
      cutByDenylist.push(`${r.slug}  (${patternText[hit]})`);
      continue;
    }

    if (r.fork || r.archived) {
      cutByData.push(`${r.slug}  fork/archived`);
      continue;
    }
    if (!(r.stars >= MIN_STARS)) {
      cutByData.push(`${r.slug}  stars=${r.stars}`);
      continue;
    }

    // Per-stat validation. A stat that fails becomes null and the repo simply
    // sits out puzzles for that stat — it is not dropped, because the repos most
    // likely to be missing a stat are the biggest and most recognisable ones.
    // Floors, not just non-zero. The gap rule is a ratio, so 3 open issues and
    // 2 open issues technically "differ by 1.5x" and pass — while being
    // completely unrankable by a human. Nobody has a prior on whether a project
    // has two or three open issues. Below these thresholds the number stops
    // carrying information about the project and the puzzle becomes a coin flip.
    const commits = r.commits !== null && r.commits >= 500 && r.commits < MAX_COMMITS ? r.commits : null;
    const contributors = r.contributors !== null && r.contributors >= 25 ? r.contributors : null;
    const firstCommitMs =
      r.firstCommitMs !== null && r.firstCommitMs > MIN_FIRST_COMMIT && r.firstCommitMs < Date.now()
        ? r.firstCommitMs
        : null;
    const openIssues = r.openIssues >= 50 ? r.openIssues : null;

    const repo: Repo = {
      slug: r.slug,
      lang: r.lang,
      stars: r.stars,
      contributors,
      openIssues,
      commits,
      firstCommitMs
    };

    // A repo needs at least two usable stats to be worth carrying.
    const usable = STAT_KEYS.filter((s) => hasStat(repo, s));
    if (usable.length < 2) {
      cutByData.push(`${r.slug}  only ${usable.length} usable stat(s)`);
      continue;
    }

    for (const s of STAT_KEYS) {
      if (!hasStat(repo, s)) (missing[s] ??= []).push(r.slug);
    }

    kept.push(repo);
  }

  kept.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));

  const overflow = kept.length - MAX_REPOS;
  if (overflow > 0) kept.length = MAX_REPOS;

  // ------------------------------------------------------------ emit

  await mkdir(path.dirname(OUT), { recursive: true });

  // One line per repo inside a single string literal, rather than 700 object
  // literals. Lakebed compiles server code to an IR that expands each literal
  // into its own node, which turned a 100KB module into ~550KB of artifact and
  // pushed the deploy past its 1MB ceiling. A string is one node; the split
  // below costs a few milliseconds at cold start and nothing after.
  const num = (v: number | null) => (v === null ? "" : String(v));
  const rows = kept.map((r) =>
    [r.slug, num(r.stars), num(r.contributors), num(r.openIssues), num(r.commits), num(r.firstCommitMs)].join("|")
  );

  const header = `// GENERATED by tools/build-dataset.ts — do not edit by hand.
// Source: data/raw/ (GitHub API), filtered through data/denylist.txt.
// Regenerate with: node tools/build-dataset.ts
//
// Encoded as one line per repo rather than object literals, to keep the
// deployed artifact under its size limit — see the note in build-dataset.ts.
// Fields: slug|stars|contributors|openIssues|commits|firstCommitMs
// An empty field means GitHub would not serve that number for this repo, and
// the repo sits out puzzles for that stat. See shared/types.ts hasStat().

import type { Repo } from "../../shared/types.ts";

const DATA = ${JSON.stringify(rows.join("\n"))};

const n = (s: string): number | null => (s === "" ? null : Number(s));

export const REPOS: Repo[] = DATA.split("\\n").map((line) => {
  const f = line.split("|");
  return {
    slug: f[0],
    stars: n(f[1]),
    contributors: n(f[2]),
    openIssues: n(f[3]),
    commits: n(f[4]),
    firstCommitMs: n(f[5])
  };
});
`;

  await writeFile(OUT, header);

  // ------------------------------------------------------------ report

  console.log(`raw repos:        ${files.length}`);
  console.log(`cut by denylist:  ${cutByDenylist.length}`);
  console.log(`cut by bad data:  ${cutByData.length}`);
  if (overflow > 0) console.log(`cut by star cap:  ${overflow}  (kept top ${MAX_REPOS})`);
  console.log(`kept:             ${kept.length}   (floor ${kept[kept.length - 1]?.stars?.toLocaleString()} stars)`);
  console.log();
  console.log("usable repos per stat:");
  for (const s of STAT_KEYS) {
    const n = kept.filter((r) => hasStat(r, s)).length;
    const gone = missing[s]?.length ?? 0;
    console.log(`  ${s.padEnd(13)} ${String(n).padStart(4)}${gone ? `   (${gone} missing: ${missing[s]!.slice(0, 5).join(", ")}${gone > 5 ? ", ..." : ""})` : ""}`);
  }

  if (process.argv.includes("--verbose")) {
    console.log("\ncut by denylist:");
    for (const s of cutByDenylist) console.log(`  ${s}`);
    console.log("\ncut by bad data:");
    for (const s of cutByData) console.log(`  ${s}`);
  } else {
    console.log("\nre-run with --verbose to see every cut (review these before shipping)");
  }

  console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
}

await main();
