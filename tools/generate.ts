// Rules used only when baking the calendar offline.
//
// This lives in tools/ rather than shared/ for a concrete reason. Lakebed's
// anonymous deploy target rejects a list of language constructs, and it decides
// by running regexes over the raw text of every file under server/ and shared/
// — not over an import graph. So an unreachable helper in shared/ still fails
// the build, and so does a comment that merely names a banned construct.
//
// tools/ is outside that scan, which is the right place for code that only ever
// runs on a build machine.
//
// Nothing here is imported by the server or the client.

import { mulberry32, shuffled } from "../shared/rng.ts";
import { SLOTS } from "../shared/puzzle.ts";
import type { Repo, StatKey } from "../shared/types.ts";
import { STAT_KEYS, statValue } from "../shared/types.ts";

/**
 * The stat for every day, as one deterministic sequence.
 *
 * Replaces a fixed weekday table, which had two problems. It was guessable —
 * Monday was always stars — and it was lopsided: five stats do not divide into
 * seven days, so stars and commits took two slots each and the rest took one.
 * Over 400 days that ran 115 and 114 against 57 for contributors, which the
 * design notes call the best stat in the set.
 *
 * Instead: shuffle a bag holding each stat exactly twice, deal ten days from it,
 * refill. Balance is exact over every block of ten, and knowing four days of a
 * block tells a player almost nothing about the rest — unlike a bag of five,
 * where by midweek the remainder is deducible.
 *
 * No stat ever lands two days running, including across a block seam.
 *
 * Sequential by construction, so it is computed once when the calendar is baked
 * and read back per day. Nothing derives it at runtime.
 */
export function statSchedule(days: number, seed: number): StatKey[] {
  const rng = mulberry32(seed);
  const out: StatKey[] = [];

  while (out.length < days) {
    const bag = [...STAT_KEYS, ...STAT_KEYS];

    let block: StatKey[] = [];
    for (let attempt = 0; attempt < 200; attempt++) {
      block = shuffled(rng, bag);
      const seamOk = out.length === 0 || block[0] !== out[out.length - 1];
      const innerOk = block.every((s, i) => i === 0 || s !== block[i - 1]);
      if (seamOk && innerOk) break;
    }

    out.push(...block);
  }

  return out.slice(0, days);
}

/**
 * Minimum separation between two adjacent values in a sorted answer.
 *
 * Ties, and near-ties, are worse than a hard puzzle: the player is guessing a
 * coin flip and the board feels broken rather than difficult.
 *
 * Count-like stats use a ratio, because the difference between 40 and 80 stars
 * matters and the difference between 300,000 and 300,040 does not.
 *
 * Age cannot use a ratio at all. `statValue` returns a negated timestamp for it,
 * so the numbers are large and negative and their ratio is always ~1.0 — every
 * pair would look like a tie and the sampler would reject forever. Age is
 * compared by elapsed time instead.
 */
const MIN_RATIO = 1.35;
const MIN_AGE_GAP_MS = 400 * 86_400_000; // ~13 months

export function wellSeparated(stat: StatKey, higher: number, lower: number): boolean {
  if (stat === "age") return higher - lower >= MIN_AGE_GAP_MS;
  if (lower <= 0) return false;
  return higher / lower >= MIN_RATIO;
}

/**
 * The largest value that still counts as properly separated below `value`.
 *
 * Lets the calendar generator build a puzzle as a descending chain — pick a
 * repo, drop the ceiling, pick the next below it — instead of drawing five at
 * random and praying they happen to be spread out.
 */
export function ceilingBelow(stat: StatKey, value: number): number {
  return stat === "age" ? value - MIN_AGE_GAP_MS : value / MIN_RATIO;
}

/**
 * The ceiling after `steps` further separations. Used to check, before
 * committing to a repo, that the pool still holds something low enough to fill
 * every remaining slot — so the chain can never paint itself into a corner.
 */
export function ceilingAfter(stat: StatKey, value: number, steps: number): number {
  if (stat === "age") return value - MIN_AGE_GAP_MS * steps;
  return value / Math.pow(MIN_RATIO, steps);
}

/** Whether a candidate set, in any order, makes a fair puzzle for this stat. */
export function isFairSet(repos: readonly Repo[], stat: StatKey): boolean {
  if (repos.length !== SLOTS) return false;
  const values = repos.map((r) => statValue(r, stat)).sort((a, b) => b - a);
  for (let i = 1; i < values.length; i++) {
    if (!wellSeparated(stat, values[i - 1], values[i])) return false;
  }
  return true;
}

/** Repo indices sorted into answer order — the correct ordering, most first. */
export function answerOrder(repos: readonly Repo[], indices: readonly number[], stat: StatKey): number[] {
  return indices.slice().sort((a, b) => statValue(repos[b], stat) - statValue(repos[a], stat));
}
