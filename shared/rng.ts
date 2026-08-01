// Deterministic pseudo-randomness. Pure, no state outside the returned closure.
//
// Everything the puzzle generator does has to be reproducible from a seed:
// the same day must produce the same board on every machine, forever. Math.random
// is therefore banned in the generator path.

/**
 * mulberry32 — small, fast, good enough distribution for picking repos.
 * Not cryptographic, and does not need to be.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, max). */
export function randInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}

/** Fisher-Yates, returns a new array. */
export function shuffled<T>(rng: () => number, items: readonly T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A permutation of `items` with no element left in its original position.
 *
 * Used for the order the player sees on load: any repo that happens to start in
 * its correct slot would be a free lock, which wastes the first guess and makes
 * the opening board inconsistent between players.
 *
 * Rejection sampling. For n=5 roughly 37% of shuffles are already derangements,
 * so this converges immediately; the cap only exists so a caller can never hang.
 */
export function derangement<T>(rng: () => number, items: readonly T[]): T[] {
  if (items.length < 2) return items.slice();
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = shuffled(rng, items);
    if (candidate.every((v, i) => v !== items[i])) return candidate;
  }
  // Fall back to a rotation, which is a derangement by construction.
  return items.map((_, i) => items[(i + 1) % items.length]);
}
