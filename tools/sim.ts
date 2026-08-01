/**
 * Measure how hard the game actually is, so the guess budgets come from data
 * rather than from a hunch.
 *
 *   node tools/sim.ts
 *
 * WHAT THIS MEASURES, AND WHAT IT DOES NOT
 *
 * Stripped of its repos, Bubblesort is Mastermind over the 120 permutations of
 * five items, with per-slot exact-match feedback and nothing else. That
 * structure is identical on every single day, so this does not need the
 * calendar or the dataset — every one of the 120 possible answers is simulated
 * directly.
 *
 * The solvers here have ZERO domain knowledge. They cannot look at
 * `torvalds/linux` and think "that one is probably first". So these numbers are
 * a FLOOR on difficulty: a budget that a blind logician can clear is
 * comfortably clearable by an informed developer, who starts with real priors
 * about which repo ranks where. If a budget is unsolvable here, it is
 * unquestionably too tight; if it is solvable here, it is fair.
 *
 * Locking correct slots does not add information — it only stops a player from
 * wasting a guess by un-solving a slot they had already found. Both solvers
 * play consistently, so locking is implicit and costs them nothing.
 */

import { SLOTS } from "../shared/puzzle.ts";
import { mulberry32, randInt } from "../shared/rng.ts";

// ---------------------------------------------------------------- setup

function permutations(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  const walk = (prefix: number[], rest: number[]) => {
    if (rest.length === 0) {
      out.push(prefix);
      return;
    }
    for (let i = 0; i < rest.length; i++) {
      walk([...prefix, rest[i]], [...rest.slice(0, i), ...rest.slice(i + 1)]);
    }
  };
  walk([], Array.from({ length: n }, (_, i) => i));
  return out;
}

const PERMS = permutations(SLOTS);

/**
 * Feedback as a bitmask of which slots are exactly right. Precomputed for every
 * (guess, answer) pair — 120x120 is trivial and makes the minimax search fast.
 */
const FEEDBACK: Uint8Array = new Uint8Array(PERMS.length * PERMS.length);
for (let g = 0; g < PERMS.length; g++) {
  for (let a = 0; a < PERMS.length; a++) {
    let mask = 0;
    for (let i = 0; i < SLOTS; i++) if (PERMS[g][i] === PERMS[a][i]) mask |= 1 << i;
    FEEDBACK[g * PERMS.length + a] = mask;
  }
}

const fb = (g: number, a: number) => FEEDBACK[g * PERMS.length + a];
const SOLVED = (1 << SLOTS) - 1;

// ---------------------------------------------------------------- solvers

/**
 * Plays like an engaged human: always guesses an arrangement that is still
 * consistent with everything seen so far, chosen arbitrarily among those.
 *
 * This is the realistic model. A person will not run a minimax search, but they
 * will reliably avoid contradicting a lock they already earned.
 */
function solveGreedy(answer: number, rng: () => number, cap: number): number {
  let candidates = PERMS.map((_, i) => i);
  for (let turn = 1; turn <= cap; turn++) {
    const guess = candidates[randInt(rng, candidates.length)];
    const mark = fb(guess, answer);
    if (mark === SOLVED) return turn;
    candidates = candidates.filter((c) => fb(guess, c) === mark);
  }
  return Infinity;
}

/**
 * Optimal-ish play: picks the guess whose worst-case surviving candidate set is
 * smallest, preferring guesses that could themselves be the answer.
 *
 * This is the ceiling — nobody plays this well, but it establishes whether a
 * budget is winnable at all.
 */
function solveMinimax(answer: number, cap: number): number {
  let candidates = PERMS.map((_, i) => i);
  for (let turn = 1; turn <= cap; turn++) {
    let guess: number;
    if (candidates.length === 1) {
      guess = candidates[0];
    } else if (turn === 1) {
      // By symmetry every opening guess is equivalent, so skip the search.
      guess = 0;
    } else {
      let bestWorst = Infinity;
      let bestIsCandidate = false;
      guess = candidates[0];
      for (let g = 0; g < PERMS.length; g++) {
        const buckets = new Map<number, number>();
        for (const c of candidates) {
          const m = fb(g, c);
          buckets.set(m, (buckets.get(m) ?? 0) + 1);
        }
        // A guess that could be the answer might end the game outright.
        const solvesNow = buckets.has(SOLVED);
        let worst = 0;
        for (const [m, n] of buckets) if (m !== SOLVED && n > worst) worst = n;

        if (worst < bestWorst || (worst === bestWorst && solvesNow && !bestIsCandidate)) {
          bestWorst = worst;
          bestIsCandidate = solvesNow;
          guess = g;
        }
      }
    }

    const mark = fb(guess, answer);
    if (mark === SOLVED) return turn;
    candidates = candidates.filter((c) => fb(guess, c) === mark);
  }
  return Infinity;
}

// ---------------------------------------------------------------- report

const CAP = 10;
const TRIALS = 400;

function summarise(name: string, results: number[]) {
  const solved = results.filter((r) => r !== Infinity);
  const mean = solved.reduce((a, b) => a + b, 0) / solved.length;
  const worst = Math.max(...solved);

  console.log(`\n${name}`);
  console.log(`  games        ${results.length.toLocaleString()}`);
  console.log(`  mean guesses ${mean.toFixed(2)}`);
  console.log(`  worst case   ${worst}`);
  console.log("  solve rate by budget:");
  for (let budget = 3; budget <= 7; budget++) {
    const rate = results.filter((r) => r <= budget).length / results.length;
    const bar = "#".repeat(Math.round(rate * 40));
    console.log(`    ${budget}  ${(rate * 100).toFixed(1).padStart(5)}%  ${bar}`);
  }
  console.log("  guess distribution:");
  for (let n = 1; n <= 8; n++) {
    const count = results.filter((r) => r === n).length;
    if (!count) continue;
    console.log(`    ${n}  ${((count / results.length) * 100).toFixed(1).padStart(5)}%`);
  }
}

console.log(`Bubblesort difficulty simulation`);
console.log(`${PERMS.length} possible answers, ${SLOTS} slots, per-slot exact-match feedback only.`);
console.log(`Solvers have no knowledge of the repos — these numbers are a floor on difficulty.`);

const rng = mulberry32(0x5eed);
const greedy: number[] = [];
for (let t = 0; t < TRIALS; t++) {
  for (let a = 0; a < PERMS.length; a++) greedy.push(solveGreedy(a, rng, CAP));
}
summarise(`GREEDY  (guesses a consistent arrangement — the realistic model)`, greedy);

const minimax = PERMS.map((_, a) => solveMinimax(a, CAP));
summarise(`MINIMAX (optimal-ish — establishes what is winnable at all)`, minimax);

// ---------------------------------------------------------------- verdict

const greedyAt = (b: number) => greedy.filter((r) => r <= b).length / greedy.length;

/**
 * Targets, chosen against what the numbers above actually show.
 *
 * Hard should hurt: a blind solver landing somewhere in 60-85% means real risk
 * of losing, which an informed player pulls upward with their priors. Easy
 * should be a safety net: a consistent player finishes essentially always, and
 * the interest lives in the score rather than in survival.
 */
const HARD_BAND: [number, number] = [0.6, 0.88];
const EASY_TARGET = 0.995;

console.log(`\n${"-".repeat(60)}`);
console.log("VERDICT");

let hard = 3;
for (let b = 2; b <= 7; b++) {
  const rate = greedyAt(b);
  if (rate >= HARD_BAND[0] && rate <= HARD_BAND[1]) {
    hard = b;
    break;
  }
}
let easy = hard + 1;
for (let b = hard + 1; b <= 8; b++) {
  if (greedyAt(b) >= EASY_TARGET) {
    easy = b;
    break;
  }
}

console.log(`  Hard: ${hard} guesses  (blind solve rate ${(greedyAt(hard) * 100).toFixed(1)}%)`);
console.log(`  Easy: ${easy} guesses  (blind solve rate ${(greedyAt(easy) * 100).toFixed(1)}%)`);
console.log(`\nSet these as BUDGET in shared/puzzle.ts.`);
console.log(
  `\nNote: the plan's original 6/4 assumed this game was much harder than it is.\n` +
    `At 6 the Easy player has two guesses they can never need — the worst case\n` +
    `here is ${Math.max(...greedy.filter((r) => r !== Infinity))}. Budgets that can't be spent are not generosity, they\n` +
    `just remove the tension from the last third of the board.`
);
