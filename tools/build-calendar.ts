/**
 * Pre-bake the puzzle calendar.
 *
 *   npm run calendar -- [days]
 *
 * Writes server/data/calendar.gen.ts plus a human-readable audit at
 * data/calendar-audit.txt.
 *
 * The calendar is generated offline rather than derived at runtime because two
 * of the three fairness rules are impossible to enforce per-day: "no repo set
 * repeats within 400 days" and "no single repo appears twice in 30 days" both
 * need to see the whole sequence at once. Baking also means a bad day can be
 * spotted in the audit and deleted before anyone plays it.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { REPOS } from "../server/data/repos.gen.ts";
import { EPOCH_DAY } from "../shared/format.ts";
import { SLOTS, weekdayOf } from "../shared/puzzle.ts";
import { answerOrder, ceilingAfter, ceilingBelow, isFairSet, statSchedule } from "./generate.ts";
import { derangement, mulberry32, randInt } from "../shared/rng.ts";
import { STAT_KEYS, hasStat, statValue } from "../shared/types.ts";
import type { CalendarDay, StatKey } from "../shared/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "server", "data", "calendar.gen.ts");
const AUDIT = path.join(ROOT, "data", "calendar-audit.txt");

const DAYS = Number(process.argv[2] ?? 1_100); // ~3 years
/** A repo may not reappear within this many days. */
const REPO_COOLDOWN = 30;
/** The same five repos may not reappear as a set within this many days. */
const SET_COOLDOWN = 400;
/** Draws to try before relaxing the cooldowns for a day. */
const MAX_ATTEMPTS = 4_000;

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * Canonical calendars use private seeds so publishing the generator and a
 * freshly fetched GitHub snapshot is not enough to reconstruct future days.
 * `.env.calendar.local` is deliberately ignored; see its checked-in example.
 */
function privateSeed(name: string): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  if (!raw || !Number.isInteger(parsed) || parsed < 0 || parsed > 0xffff_ffff) {
    throw new Error(`${name} must be an unsigned 32-bit integer in .env.calendar.local`);
  }
  return parsed >>> 0;
}

const STAT_SEED = privateSeed("BUBBLESORT_STAT_SEED");
const DAY_SEED = privateSeed("BUBBLESORT_DAY_SEED");

/** The stat for every day, dealt once for the whole run. See statSchedule(). */
const SCHEDULE = statSchedule(DAYS, STAT_SEED);

function setKey(indices: readonly number[]): string {
  return indices.slice().sort((a, b) => a - b).join(",");
}

/** Repo indices eligible for each stat, precomputed once. */
const eligible: Record<StatKey, number[]> = Object.fromEntries(
  STAT_KEYS.map((s) => [s, REPOS.map((_, i) => i).filter((i) => hasStat(REPOS[i], s))])
) as Record<StatKey, number[]>;

/** Eligible repos per stat, sorted by value descending, with values cached. */
const rankedByStat: Record<StatKey, { idx: number; value: number }[]> = Object.fromEntries(
  STAT_KEYS.map((s) => [
    s,
    eligible[s]
      .map((idx) => ({ idx, value: statValue(REPOS[idx], s) }))
      .sort((a, b) => b.value - a.value)
  ])
) as Record<StatKey, { idx: number; value: number }[]>;

/**
 * Build one puzzle as a descending chain: pick the top repo, drop the ceiling
 * by the gap rule, pick the next below it, repeat.
 *
 * Two earlier approaches failed here, and both failures are instructive.
 *
 * Uniform rejection sampling — draw five at random, keep them if they happen to
 * satisfy the gap rule — collapsed on day 139. Every stat is power-law
 * distributed (stars run 36k to 385k with the vast majority near the floor), so
 * a random five-set is nearly always a cluster of near-ties.
 *
 * Fixed geometric bands, one repo drawn per band, fixed that but destroyed
 * variety: the top band for `commits` held exactly one repo, so python/cpython
 * appeared in all 157 of its days. A puzzle you can partly predict from the day
 * of the week is not a puzzle.
 *
 * Chaining samples uniformly among every repo that is a *valid continuation* at
 * each step, which keeps the gap guarantee while drawing from the widest legal
 * pool at every slot. The headroom check ensures a partial chain can never
 * paint itself into a corner, so there is no backtracking.
 */
function pickChain(stat: StatKey, rng: () => number, allowed: (idx: number) => boolean): number[] | null {
  const ranked = rankedByStat[stat];
  const floor = ranked[ranked.length - 1].value;
  /**
   * The chain's top repo has to come from the upper half of the pool.
   *
   * Without this the chain often starts near the bottom and produces a board of
   * five obscure repos with small, close numbers — technically passing the gap
   * rule and completely unplayable. Anchoring the top high forces every puzzle
   * to span a range worth reasoning about.
   */
  const topMin = ranked[Math.floor(ranked.length / 2)].value;

  const picked: number[] = [];
  const used = new Set<number>();
  let ceiling = Infinity;

  for (let slot = 0; slot < SLOTS; slot++) {
    const remaining = SLOTS - slot - 1;

    const candidates = ranked.filter(
      (r) =>
        !used.has(r.idx) &&
        allowed(r.idx) &&
        r.value <= ceiling &&
        (slot > 0 || r.value >= topMin) &&
        // Leave enough room below for every slot still to be filled.
        (remaining === 0 || ceilingAfter(stat, r.value, remaining) >= floor)
    );
    if (candidates.length === 0) return null;

    const chosen = candidates[randInt(rng, candidates.length)];
    picked.push(chosen.idx);
    used.add(chosen.idx);
    ceiling = ceilingBelow(stat, chosen.value);
  }

  return picked;
}

interface Attempted {
  day: CalendarDay;
  attempts: number;
  relaxed: boolean;
}

function buildDay(day: number, lastUsedRepo: Map<number, number>, lastUsedSet: Map<string, number>): Attempted {
  const stat = SCHEDULE[day];
  if (rankedByStat[stat].length < SLOTS) {
    throw new Error(`stat "${stat}" only has ${rankedByStat[stat].length} eligible repos, need ${SLOTS}`);
  }

  // Seeded on the day, so a private seed reproduces the whole calendar without
  // making that calendar reconstructable from the public source.
  const rng = mulberry32(DAY_SEED ^ (day * 2_654_435_761));

  for (let attempt = 0; attempt < MAX_ATTEMPTS * 2; attempt++) {
    // After MAX_ATTEMPTS the cooldowns are dropped rather than looping forever.
    // With ~700 repos this effectively never triggers, but a smaller dataset
    // should degrade to a playable puzzle instead of hanging the build.
    const relaxed = attempt >= MAX_ATTEMPTS;

    const picked = pickChain(stat, rng, (idx) => {
      if (relaxed) return true;
      const last = lastUsedRepo.get(idx);
      return last === undefined || day - last >= REPO_COOLDOWN;
    });
    if (!picked) continue;

    if (!relaxed && day - (lastUsedSet.get(setKey(picked)) ?? -Infinity) < SET_COOLDOWN) continue;
    if (!isFairSet(picked.map((i) => REPOS[i]), stat)) continue;

    const answer = answerOrder(REPOS, picked, stat);
    // The board the player sees must have no repo already in its correct slot —
    // a free lock on load wastes the first guess.
    const shown = derangement(rng, answer);

    return { day: { day, stat, answer, shown }, attempts: attempt + 1, relaxed };
  }

  throw new Error(`could not build a fair puzzle for day ${day} (stat "${stat}")`);
}

async function main() {
  if (REPOS.length < 50) {
    console.error(`dataset has only ${REPOS.length} repos. run: node tools/build-dataset.ts`);
    process.exit(1);
  }

  const lastUsedRepo = new Map<number, number>();
  const lastUsedSet = new Map<string, number>();
  const days: CalendarDay[] = [];
  const audit: string[] = [];
  let relaxedCount = 0;
  let totalAttempts = 0;

  for (let day = 0; day < DAYS; day++) {
    const { day: built, attempts, relaxed } = buildDay(day, lastUsedRepo, lastUsedSet);
    totalAttempts += attempts;
    if (relaxed) relaxedCount++;

    for (const idx of built.answer) lastUsedRepo.set(idx, day);
    lastUsedSet.set(setKey(built.answer), day);
    days.push(built);

    const absolute = EPOCH_DAY + day;
    const date = new Date(absolute * 86_400_000).toISOString().slice(0, 10);
    audit.push(
      `#${String(day + 1).padStart(4)}  ${date} ${DOW[weekdayOf(absolute)]}  ${built.stat}${relaxed ? "  [RELAXED]" : ""}`
    );
    for (const idx of built.answer) {
      const repo = REPOS[idx];
      const v = statValue(repo, built.stat);
      const shown = built.stat === "age" ? new Date(-v).toISOString().slice(0, 10) : v.toLocaleString("en-US");
      audit.push(`        ${repo.slug.padEnd(42)} ${shown}`);
    }
    audit.push("");
  }

  // ------------------------------------------------------------ emit

  await mkdir(path.dirname(OUT), { recursive: true });

  // One line per day in a single string literal. See the note in
  // build-dataset.ts: object literals expand into individual IR nodes and blow
  // the deployed artifact past its size limit. The day number is the array
  // index, so it is not stored.
  const rows = days.map((d) => `${d.stat}|${d.answer.join(",")}|${d.shown.join(",")}`);

  await writeFile(
    OUT,
    `// GENERATED by tools/build-calendar.ts — do not edit by hand.
// ${DAYS} days from EPOCH_DAY. Regenerate with: npm run calendar
//
// Encoded as one line per day: stat|answer|shown, where the day number is the
// line index. Indices point into REPOS in ./repos.gen.ts — regenerating the
// dataset without regenerating the calendar will silently re-point every
// puzzle, so always run both, in that order.

import type { CalendarDay, StatKey } from "../../shared/types.ts";

const DATA = ${JSON.stringify(rows.join("\n"))};

const idx = (s: string): number[] => s.split(",").map(Number);

export const CALENDAR: CalendarDay[] = DATA.split("\\n").map((line, day) => {
  const f = line.split("|");
  return { day, stat: f[0] as StatKey, answer: idx(f[1]), shown: idx(f[2]) };
});
`
  );

  await writeFile(AUDIT, audit.join("\n"));

  // ------------------------------------------------------------ report

  const byStat = new Map<StatKey, number>();
  for (const d of days) byStat.set(d.stat, (byStat.get(d.stat) ?? 0) + 1);

  const uses = new Map<number, number>();
  for (const d of days) for (const i of d.answer) uses.set(i, (uses.get(i) ?? 0) + 1);

  console.log(`days generated:    ${days.length}`);
  console.log(`avg draws per day: ${(totalAttempts / days.length).toFixed(1)}`);
  console.log(`relaxed days:      ${relaxedCount}`);
  console.log(`distinct repos:    ${uses.size} of ${REPOS.length}`);
  console.log();
  console.log("days per stat:");
  for (const s of STAT_KEYS) {
    console.log(`  ${s.padEnd(13)} ${String(byStat.get(s) ?? 0).padStart(4)}   (${eligible[s].length} eligible repos)`);
  }

  const hottest = [...uses.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log("\nmost-used repos:");
  for (const [idx, n] of hottest) console.log(`  ${String(n).padStart(3)}x  ${REPOS[idx].slug}`);

  console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
  console.log(`wrote ${path.relative(ROOT, AUDIT)}  <- skim this before shipping`);
}

await main();
