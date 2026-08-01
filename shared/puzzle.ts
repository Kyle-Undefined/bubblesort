// Puzzle rules the running game needs.
//
// Deliberately small, and free of loop constructs beyond fixed-length array
// methods. Everything the offline calendar generator needs lives in
// tools/generate.ts instead — see the note there for why that separation is
// load-bearing rather than tidiness.
//
// Pure TS: no DOM, no Node, no lakebed imports.

import type { Mode } from "./types.ts";

/** Five slots, always. */
export const SLOTS = 5;

/**
 * Guesses allowed per mode. Measured, not guessed — see tools/sim.ts.
 *
 * Stripped of repos this is Mastermind over 120 permutations with per-slot
 * exact-match feedback. A solver with no knowledge of the repos at all needs a
 * mean of 3.0 guesses, and its worst case over every possible answer is 5:
 *
 *     3 guesses ->  74.1% solved
 *     4 guesses ->  98.7% solved
 *     5 guesses -> 100.0% solved
 *
 * So Hard is 3 — the only budget where losing is a real possibility — and Easy
 * is 5, where anyone who never contradicts a lock they already earned will
 * finish. The interest in Easy is the score, not survival.
 *
 * The original plan said 6 and 4. Both were dead: at 6 an Easy player holds two
 * guesses that cannot ever be needed, and 4 made "Hard" a 98.7% freebie. A
 * budget that cannot be spent doesn't read as generous, it just drains the
 * tension out of the last third of the board.
 *
 * Informed players do better than these numbers, because they can look at
 * `torvalds/linux` and know roughly where it lands. That makes these a floor.
 */
export const BUDGET: Record<Mode, number> = {
  easy: 5,
  hard: 3
};

/** UTC day-of-week for an absolute day number, 0 = Sunday. 1970-01-01 was a Thursday. */
export function weekdayOf(absoluteDay: number): number {
  return (((absoluteDay + 4) % 7) + 7) % 7;
}

/**
 * Grade a submitted ordering against the answer.
 *
 * Per-slot only: a slot is either in the right place or it is not. There is no
 * "close" signal — that is what makes the game Mastermind over permutations
 * rather than a hotter/colder hunt.
 */
export function grade(order: readonly number[], answer: readonly number[]): boolean[] {
  return order.map((v, i) => v === answer[i]);
}

/**
 * Exactly four correct is impossible: if four slots hold the right repo, the
 * fifth has nowhere else to be. A board rendering four locks would be a bug in
 * the grader, so callers assert this rather than displaying it.
 */
export function isImpossibleMarkCount(marks: readonly boolean[]): boolean {
  return marks.filter(Boolean).length === SLOTS - 1;
}
