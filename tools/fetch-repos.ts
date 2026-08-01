/**
 * Pull the candidate repo pool from the GitHub API into data/raw/.
 *
 * Runs OUTSIDE the lakebed capsule — it needs fetch, fs, and rate-limit
 * backoff, none of which capsule code is allowed to have.
 *
 *   GITHUB_TOKEN=$(gh auth token) node tools/fetch-repos.ts
 *
 * Everything is cached per repo on disk and skipped on re-run, so a rate-limit
 * wall is a pause-and-resume rather than a restart.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const RAW = path.join(ROOT, "data", "raw");
const REPO_DIR = path.join(RAW, "repo");
const SEARCH_CACHE = path.join(RAW, "_search.json");

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN is required. Try: GITHUB_TOKEN=$(gh auth token) node tools/fetch-repos.ts");
  process.exit(1);
}

/** Star floor for the candidate pool. Everything at or above this gets pulled. */
const MIN_STARS = 20_000;
/** How many enriched repos we want before hand-filtering. */
const TARGET = 1_500;
/** Parallel enrichment workers. Kept low so rate-limit backoff stays legible. */
const CONCURRENCY = 6;

// ---------------------------------------------------------------- http

interface Res {
  status: number;
  headers: Headers;
  body: any;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let requestCount = 0;

async function api(url: string, attempt = 0): Promise<Res> {
  const res = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${TOKEN}`,
      "user-agent": "bubblesort-dataset-builder",
      "x-github-api-version": "2022-11-28"
    }
  });
  requestCount++;

  const remaining = Number(res.headers.get("x-ratelimit-remaining") ?? "1");
  const reset = Number(res.headers.get("x-ratelimit-reset") ?? "0");

  // A 403 is ambiguous: it can be a rate limit (wait and retry) or a permanent
  // refusal (retrying forever accomplishes nothing). GitHub returns a plain 403
  // with an explanatory message for endpoints it will never serve for a given
  // repo — notably `contributors` on torvalds/linux, whose history it calls
  // "too large to list". Only retry when it is actually a limit.
  const retryAfter = Number(res.headers.get("retry-after") ?? "0");
  const isRateLimited =
    res.status === 429 || (res.status === 403 && (retryAfter > 0 || remaining === 0));

  if (isRateLimited) {
    let waitMs = retryAfter > 0 ? retryAfter * 1000 : 0;
    if (!waitMs && reset) waitMs = Math.max(0, reset * 1000 - Date.now()) + 2_000;
    if (!waitMs) waitMs = Math.min(60_000, 2 ** attempt * 1_000);

    if (attempt > 8) throw new Error(`giving up on ${url} after ${attempt} rate-limit retries`);
    console.log(`  rate limited, sleeping ${Math.round(waitMs / 1000)}s  (${url.replace("https://api.github.com", "")})`);
    await sleep(waitMs);
    return api(url, attempt + 1);
  }

  // Transient server errors.
  if (res.status >= 500 && attempt < 5) {
    await sleep(2 ** attempt * 1_000);
    return api(url, attempt + 1);
  }

  const text = await res.text();
  let body: any = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  // Stay clear of the wall rather than sprinting into it. The threshold has to
  // scale with the bucket: core allows 5,000/hr but search only allows 30/min,
  // so any fixed number large enough to protect core would trip on every single
  // search request and stall the run.
  const limit = Number(res.headers.get("x-ratelimit-limit") ?? "5000");
  const floor = Math.max(3, Math.floor(limit * 0.02));
  if (remaining > 0 && remaining <= floor && reset) {
    const waitMs = Math.max(0, reset * 1000 - Date.now()) + 2_000;
    console.log(`  ${remaining}/${limit} requests left, sleeping ${Math.round(waitMs / 1000)}s until reset`);
    await sleep(waitMs);
  }

  return { status: res.status, headers: res.headers, body };
}

/** Page number from a Link header's rel="last", or null when there is only one page. */
function lastPage(link: string | null): number | null {
  if (!link) return null;
  const m = /<([^>]+)>;\s*rel="last"/.exec(link);
  if (!m) return null;
  const page = new URL(m[1]).searchParams.get("page");
  return page ? Number(page) : null;
}

// ---------------------------------------------------------------- search

interface Candidate {
  slug: string;
  lang: string | null;
  stars: number;
  openIssues: number;
  fork: boolean;
  archived: boolean;
}

/**
 * Upper bound for the star range. Nothing on GitHub is close to this — the
 * most-starred repo is around 400k — but the range has to be finite for
 * bisection to work at all.
 */
const MAX_STARS = 1_000_000;

function q(lo: number, hi: number): string {
  return `stars:${lo}..${hi}+is:public+archived:false`;
}

async function searchCount(lo: number, hi: number): Promise<number> {
  const res = await api(`https://api.github.com/search/repositories?q=${q(lo, hi)}&per_page=1`);
  await sleep(2_100); // search allows ~30/min; stay under it
  return res.body?.total_count ?? 0;
}

async function searchSlice(lo: number, hi: number, out: Map<string, Candidate>): Promise<void> {
  for (let page = 1; page <= 10; page++) {
    const res = await api(
      `https://api.github.com/search/repositories?q=${q(lo, hi)}&sort=stars&order=desc&per_page=100&page=${page}`
    );
    await sleep(2_100);
    const items: any[] = res.body?.items ?? [];
    for (const it of items) {
      if (out.has(it.full_name)) continue;
      out.set(it.full_name, {
        slug: it.full_name,
        lang: it.language ?? null,
        stars: it.stargazers_count,
        openIssues: it.open_issues_count,
        fork: Boolean(it.fork),
        archived: Boolean(it.archived)
      });
    }
    if (items.length < 100) break;
  }
}

/**
 * The search API refuses to page past 1,000 results, so a single
 * "top N by stars" query cannot reach 1,500. Bisect the star range until every
 * slice fits under the cap, then page each slice.
 *
 * Bisection is geometric, not arithmetic: star counts are power-law
 * distributed, so an arithmetic midpoint would put ~everything on one side.
 */
async function collect(lo: number, hi: number, out: Map<string, Candidate>): Promise<void> {
  const total = await searchCount(lo, hi);
  if (total === 0) return;

  const label = `stars ${lo}..${hi}`;
  if (total < 1000 || hi - lo <= 1) {
    console.log(`  ${label} -> ${total} results`);
    await searchSlice(lo, hi, out);
    return;
  }

  const mid = Math.max(lo, Math.min(hi - 1, Math.round(Math.sqrt(lo * hi))));
  console.log(`  ${label} -> ${total} results, splitting at ${mid}`);
  await collect(mid + 1, hi, out);
  await collect(lo, mid, out);
}

async function loadCandidates(): Promise<Candidate[]> {
  if (existsSync(SEARCH_CACHE)) {
    const cached = JSON.parse(await readFile(SEARCH_CACHE, "utf8")) as Candidate[];
    console.log(`search: ${cached.length} candidates from cache`);
    return cached;
  }

  console.log(`search: collecting repos with >= ${MIN_STARS.toLocaleString()} stars`);
  const out = new Map<string, Candidate>();
  await collect(MIN_STARS, MAX_STARS, out);

  const list = [...out.values()]
    .filter((c) => !c.fork && !c.archived)
    .sort((a, b) => b.stars - a.stars)
    .slice(0, TARGET);

  await writeFile(SEARCH_CACHE, JSON.stringify(list, null, 2));
  console.log(`search: ${list.length} candidates cached`);
  return list;
}

// ---------------------------------------------------------------- enrichment

interface RawRepo extends Candidate {
  commits: number | null;
  contributors: number | null;
  firstCommitMs: number | null;
  error?: string;
}

const cacheFile = (slug: string) => path.join(REPO_DIR, `${slug.replace("/", "__")}.json`);

/**
 * Total commits is not a field on the repo object. Ask for a single commit and
 * read the page count off the Link header's rel="last" — one request, exact
 * count. Then jump straight to that last page for the oldest commit, which is
 * the real project start date. `created_at` lies on every migrated repo
 * (git, sqlite and php all moved to GitHub years after they began).
 */
async function commitFacts(slug: string): Promise<{ commits: number | null; firstCommitMs: number | null }> {
  const first = await api(`https://api.github.com/repos/${slug}/commits?per_page=1`);
  if (first.status === 409) return { commits: 0, firstCommitMs: null }; // empty repo
  if (first.status !== 200 || !Array.isArray(first.body)) return { commits: null, firstCommitMs: null };

  const pages = lastPage(first.headers.get("link"));
  if (pages === null) {
    // Single page: the repo has one commit, and it is the first one.
    const only = first.body[0];
    const when = only?.commit?.committer?.date ?? only?.commit?.author?.date ?? null;
    return { commits: first.body.length, firstCommitMs: when ? Date.parse(when) : null };
  }

  const last = await api(`https://api.github.com/repos/${slug}/commits?per_page=1&page=${pages}`);
  const oldest = Array.isArray(last.body) ? last.body[0] : null;
  const when = oldest?.commit?.committer?.date ?? oldest?.commit?.author?.date ?? null;
  return { commits: pages, firstCommitMs: when ? Date.parse(when) : null };
}

/**
 * The contributors endpoint only resolves the first 500 author emails to real
 * GitHub users; past that everyone comes back anonymous, so the default count
 * is not a contributor count at all. `anon=1` counts every distinct author. It
 * disagrees slightly with the number on the web UI, but it is consistent across
 * the whole dataset, which is what ranking needs.
 *
 * Returns null when GitHub refuses outright — it answers 403 "history or
 * contributor list is too large" for the very biggest repos (torvalds/linux is
 * the one confirmed case in the top 1,500). Those repos keep every other stat
 * and are simply excluded from contributors puzzles; see build-dataset.ts.
 */
async function contributorCount(slug: string): Promise<number | null> {
  const res = await api(`https://api.github.com/repos/${slug}/contributors?per_page=1&anon=1`);
  if (res.status === 204) return 0;
  if (res.status !== 200 || !Array.isArray(res.body)) return null;
  const pages = lastPage(res.headers.get("link"));
  return pages ?? res.body.length;
}

async function enrich(c: Candidate): Promise<void> {
  const file = cacheFile(c.slug);
  if (existsSync(file)) return;

  try {
    const { commits, firstCommitMs } = await commitFacts(c.slug);
    const contributors = await contributorCount(c.slug);
    const rec: RawRepo = { ...c, commits, contributors, firstCommitMs };
    await writeFile(file, JSON.stringify(rec, null, 2));
  } catch (err) {
    const rec: RawRepo = {
      ...c,
      commits: null,
      contributors: null,
      firstCommitMs: null,
      error: err instanceof Error ? err.message : String(err)
    };
    await writeFile(file, JSON.stringify(rec, null, 2));
  }
}

// ---------------------------------------------------------------- main

async function main() {
  await mkdir(REPO_DIR, { recursive: true });

  const candidates = await loadCandidates();

  const done = new Set(
    (await readdir(REPO_DIR)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "").replace("__", "/"))
  );
  const todo = candidates.filter((c) => !done.has(c.slug));

  console.log(`enrich: ${done.size} cached, ${todo.length} to fetch (~${todo.length * 3} requests)`);
  if (todo.length === 0) {
    console.log("nothing to do. run: node tools/build-dataset.ts");
    return;
  }

  let cursor = 0;
  let completed = 0;
  const worker = async () => {
    while (cursor < todo.length) {
      const c = todo[cursor++];
      await enrich(c);
      completed++;
      if (completed % 25 === 0 || completed === todo.length) {
        console.log(`  ${completed}/${todo.length}  (${requestCount} requests this run)`);
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`done. ${requestCount} requests. next: node tools/build-dataset.ts`);
}

await main();
