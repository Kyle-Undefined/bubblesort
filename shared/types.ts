// Pure types shared by the offline tools, the server, and the client.
// No DOM, no Node, no lakebed imports.

export type Mode = "easy" | "hard";

/** The five rotating stats. Order here is the canonical stat index order. */
export const STAT_KEYS = ["stars", "contributors", "openIssues", "commits", "age"] as const;
export type StatKey = (typeof STAT_KEYS)[number];

/**
 * How hard each stat is to reason about, used by the weekly rotation so
 * Saturday always lands on a nasty one and Monday on a gentle one.
 */
export const STAT_DIFFICULTY: Record<StatKey, "easy" | "medium" | "hard"> = {
  stars: "easy",
  age: "easy",
  commits: "medium",
  openIssues: "hard",
  contributors: "hard"
};

/**
 * The task, minus the verb.
 *
 * The board sets "order by" as a small eyebrow and this as the line beneath it,
 * so the header reads as a heading rather than a sentence of instructions.
 */
export const STAT_PHRASE: Record<StatKey, string> = {
  stars: "stars, most first",
  contributors: "contributors, most first",
  openIssues: "open issues, most first",
  commits: "total commits, most first",
  age: "age, oldest first"
};

/** The whole instruction on one line, for anywhere that needs it as prose. */
export const STAT_PROMPT: Record<StatKey, string> = Object.fromEntries(
  STAT_KEYS.map((s) => [s, `order by ${STAT_PHRASE[s]}`])
) as Record<StatKey, string>;

/**
 * Bare noun for the stat, for prose rather than for a prompt.
 *
 * Used in the share text, which has to read as a sentence to someone who has
 * never seen the game — "ordered 5 repos by open issues" explains itself in a
 * way a grid of squares cannot.
 */
export const STAT_NOUN: Record<StatKey, string> = {
  stars: "stars",
  contributors: "contributors",
  openIssues: "open issues",
  commits: "commits",
  age: "age"
};

/** Short label used on the results screen next to each value. */
export const STAT_UNIT: Record<StatKey, string> = {
  stars: "stars",
  contributors: "contributors",
  openIssues: "open issues",
  commits: "commits",
  age: "old"
};

/**
 * One repo in the dataset.
 *
 * `firstCommitMs` is a timestamp rather than a duration so ranking is stable
 * forever — a stored duration would drift every day and silently re-order old
 * puzzles. The results screen derives a human age from it at render time.
 *
 * Every stat is nullable because GitHub will not serve all of them for all
 * repos: it answers 403 "history or contributor list is too large" on the very
 * biggest ones (torvalds/linux is the confirmed case in the top 1,500). Rather
 * than drop those repos entirely — they are the most recognisable in the set —
 * a repo simply sits out the puzzles for stats it is missing.
 */
export interface Repo {
  slug: string; // "torvalds/linux"
  stars: number | null;
  contributors: number | null;
  openIssues: number | null;
  commits: number | null;
  firstCommitMs: number | null;
}

/** Raw stored field behind each stat. */
function rawStat(repo: Repo, stat: StatKey): number | null {
  switch (stat) {
    case "stars":
      return repo.stars;
    case "contributors":
      return repo.contributors;
    case "openIssues":
      return repo.openIssues;
    case "commits":
      return repo.commits;
    case "age":
      return repo.firstCommitMs;
  }
}

/** Whether this repo can appear in a puzzle for this stat. */
export function hasStat(repo: Repo, stat: StatKey): boolean {
  return rawStat(repo, stat) !== null;
}

/**
 * The comparable value for a stat. Higher always sorts first, including for
 * age — an older repo yields a larger value, so "oldest first" is the same
 * descending sort every other stat uses and the comparator stays branch-free.
 *
 * Only valid when hasStat() is true; the calendar generator guarantees that for
 * every repo it places in a puzzle.
 */
export function statValue(repo: Repo, stat: StatKey): number {
  const raw = rawStat(repo, stat);
  if (raw === null) throw new Error(`${repo.slug} has no value for stat "${stat}"`);
  return stat === "age" ? -raw : raw;
}

/** One pre-baked day. Repo indices point into the generated dataset array. */
export interface CalendarDay {
  day: number;
  stat: StatKey;
  /** Repo indices in ANSWER order — correct ordering, most first. */
  answer: number[];
  /** The order the player sees on load. Guaranteed zero fixed points vs. answer. */
  shown: number[];
}
