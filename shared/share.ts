// Share-string construction. Pure TS: no DOM, no Node, no lakebed imports.

import { SLOTS } from "./puzzle.ts";
import { STAT_NOUN } from "./types.ts";
import type { Mode, StatKey } from "./types.ts";

export const SITE = "bubblesort.lakebed.app";

/**
 * The paste-into-a-timeline artifact.
 *
 * Deliberately not a grid of squares.
 *
 * Wordle's grid works because green/yellow/grey encodes position and letter
 * presence — the shape narrowing down the board is readable as a story. Nothing
 * equivalent survives the translation here: this game's squares would only say
 * how many slots were right on guess N, at positions that carry no meaning to a
 * reader, restating an outcome the score already gives. It would be the single
 * most Wordle-identifying artifact in existence, attached to a game whose whole
 * premise is that it is not a Wordle clone.
 *
 * A grid also only functions as an invitation for people who already recognise
 * it. For something niche and new, a share that explains itself travels further
 * than one that looks like a knockoff of something else — so this names the
 * game, the task and the stat, and reads as a sentence.
 *
 * Naming the stat spoils nothing: it is announced on the board before the first
 * guess.
 */
export function shareText(opts: {
  day: number;
  mode: Mode;
  stat: StatKey;
  guesses: number;
  solved: boolean;
  budget: number;
}): string {
  const { day, mode, stat, guesses, solved, budget } = opts;
  const score = `${solved ? guesses : "X"}/${budget}`;

  // Puzzle numbering is 1-based for humans; day 0 is "#1".
  return [
    `Bubblesort #${day + 1}`,
    `ordered ${SLOTS} repos by ${STAT_NOUN[stat]} · ${score} ${mode}`,
    SITE
  ].join("\n");
}
