import { boolean, capsule, mutation, query, string, table } from "lakebed/server";
import { CALENDAR } from "./data/calendar.gen.ts";
import { REPOS } from "./data/repos.gen.ts";
import {
  dayIndexFrom,
  daysInMonth,
  monthLabel,
  monthOfDay,
  monthSlug,
  padDay,
  parseMonthSlug,
  shiftMonth,
  unpadDay
} from "../shared/format.ts";
import { BUDGET, SLOTS, grade, isImpossibleMarkCount } from "../shared/puzzle.ts";
import { STAT_PHRASE, STAT_PROMPT, statValue } from "../shared/types.ts";
import type { CalendarDay, Mode, StatKey } from "../shared/types.ts";

// ---------------------------------------------------------------- puzzle

/**
 * The five repos a player sees, in the order they see them, plus the answer
 * expressed in that same space.
 *
 * The wire never carries global repo indices. The client works purely in
 * "item space" — 0..4, indexing the list it was handed — so nothing it receives
 * hints at where a repo sits in the dataset.
 */
interface Puzzle {
  day: number;
  stat: StatKey;
  items: { slug: string }[];
  /** answerItems[slot] = which item belongs in that slot. Server-only. */
  answerItems: number[];
}

function calendarDay(day: number): CalendarDay | null {
  const entry = CALENDAR[day];
  // CALENDAR is dense and 0-indexed by day, but guard anyway: a clock skew or a
  // deploy that outlives the baked calendar should degrade to a clear error
  // rather than serve a puzzle built from undefined.
  return entry && entry.day === day ? entry : null;
}

function buildPuzzle(day: number): Puzzle | null {
  const entry = calendarDay(day);
  if (!entry) return null;

  const items = entry.shown.map((repoIdx) => ({ slug: REPOS[repoIdx].slug }));

  // Translate the answer from global repo indices into item space.
  const answerItems = entry.answer.map((repoIdx) => entry.shown.indexOf(repoIdx));

  return { day, stat: entry.stat, items, answerItems };
}

/** The real numbers, only ever produced once a game is over. */
function reveal(day: number) {
  const entry = calendarDay(day);
  if (!entry) return [];
  return entry.answer.map((repoIdx) => {
    const repo = REPOS[repoIdx];
    return {
      slug: repo.slug,
      // Age is stored negated so that "higher sorts first" holds for every stat;
      // hand the client back the raw timestamp so it can render a human age.
      value: entry.stat === "age" ? repo.firstCommitMs! : statValue(repo, entry.stat)
    };
  });
}

// ---------------------------------------------------------------- validation

function isMode(v: unknown): v is Mode {
  return v === "easy" || v === "hard";
}

/**
 * Resolve which day the client is asking for.
 *
 * THIS CLAMP IS THE ARCHIVE'S ENTIRE SECURITY BOUNDARY. The calendar is baked
 * three years ahead, so an unclamped day parameter would happily serve every
 * future puzzle — answers included — to anyone who incremented a number in the
 * URL. Past and present only; anything else is refused outright rather than
 * silently coerced, so a bad request fails loudly instead of quietly handing
 * back the wrong board.
 */
function resolveDay(requested: unknown): { day: number; current: number; isArchive: boolean } | null {
  const current = dayIndexFrom(Date.now());
  if (requested === undefined || requested === null) {
    return { day: current, current, isArchive: false };
  }
  if (!Number.isInteger(requested)) return null;
  const day = requested as number;
  if (day < 0 || day > current) return null;
  return { day, current, isArchive: day !== current };
}

/** A submitted ordering must be a genuine permutation of the five slots. */
function isPermutation(order: unknown): order is number[] {
  if (!Array.isArray(order) || order.length !== SLOTS) return false;
  const seen = new Set<number>();
  for (const v of order) {
    if (!Number.isInteger(v) || v < 0 || v >= SLOTS || seen.has(v)) return false;
    seen.add(v);
  }
  return true;
}

/** Slots locked by any previous guess. Locks are permanent. */
function lockedSlots(guesses: number[][], marks: boolean[][]): Map<number, number> {
  const locked = new Map<number, number>();
  for (let g = 0; g < marks.length; g++) {
    for (let s = 0; s < SLOTS; s++) {
      if (marks[g]?.[s]) locked.set(s, guesses[g][s]);
    }
  }
  return locked;
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || !raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- capsule

export default capsule({
  name: "Bubblesort",

  schema: {
    /**
     * One row per (player, day, mode). `clientKey` is a uuid the browser makes
     * and keeps in localStorage — there are no accounts, so this is the only
     * notion of identity, and it is deliberately trivial to reset.
     *
     * Day keys retain the fixed-width string encoding used by existing
     * deployments so indexed ordering and saved sessions stay compatible.
     * See shared/format.ts.
     */
    sessions: table({
      clientKey: string(),
      day: string(), // padDay()
      mode: string(), // "easy" | "hard"
      guesses: string(), // JSON number[][]
      marks: string(), // JSON boolean[][]
      solved: boolean().default(false),
      finished: boolean().default(false)
    })
      .index("by_client_day", ["clientKey", "day"])
      .index("by_day_mode", ["day", "mode"]),

    /**
     * Append-only, one row per finished game, for the global distribution on
     * the results screen.
     *
     * Keep the existing per-finished-game records and calculate the
     * distribution at read time, without migrating to shared counter rows.
     */
    results: table({
      day: string(),
      mode: string(),
      bucket: string() // "1".."5", or "X" for a loss
    }).index("by_day_mode", ["day", "mode"])
  },

  queries: {
    /**
     * Everything the client needs to render the board, for both modes at once
     * so it can enforce mode-lock without a second round trip.
     *
     * Never includes a stat value for an unfinished game.
     */
    today: query(async (ctx, args: { clientKey: string; day?: number }) => {
      const resolved = resolveDay(args?.day);
      if (!resolved) return { day: -1, ready: false as const };

      const { day, current, isArchive } = resolved;
      const puzzle = buildPuzzle(day);
      if (!puzzle) return { day, ready: false as const };

      const rows =
        typeof args?.clientKey === "string" && args.clientKey
          ? await ctx.db.sessions
              .withIndex("by_client_day", (q) => q.eq("clientKey", args.clientKey).eq("day", padDay(day)))
              .collect()
          : [];

      const sessions: Record<string, unknown> = {};
      for (const row of rows) {
        const guesses = parseJson<number[][]>(row.guesses, []);
        const marks = parseJson<boolean[][]>(row.marks, []);
        sessions[String(row.mode)] = {
          guesses,
          marks,
          solved: Boolean(row.solved),
          finished: Boolean(row.finished),
          // The payoff is only ever attached to a game that is actually over.
          reveal: row.finished ? reveal(day) : null
        };
      }

      return {
        day,
        current,
        isArchive,
        ready: true as const,
        stat: puzzle.stat,
        prompt: STAT_PROMPT[puzzle.stat],
        phrase: STAT_PHRASE[puzzle.stat],
        items: puzzle.items,
        budget: BUDGET,
        sessions
      };
    }),

    /**
     * One calendar month of the archive, with the player's own result per day.
     *
     * No schema change was needed for this. `by_client_day` is a compound index
     * on [clientKey, day], so an eq on just the clientKey prefix returns every
     * session that player has — a couple of rows per day they have played.
     */
    archive: query(async (ctx, args: { clientKey: string; month?: string }) => {
      const current = dayIndexFrom(Date.now());
      const requested = typeof args?.month === "string" ? parseMonthSlug(args.month) : null;
      const ym = requested ?? monthOfDay(current);

      const span = daysInMonth(ym);
      const first = Math.max(0, span.first);
      const last = Math.min(current, span.last);

      const rows =
        typeof args?.clientKey === "string" && args.clientKey
          ? await ctx.db.sessions.withIndex("by_client_day", (q) => q.eq("clientKey", args.clientKey)).collect()
          : [];

      const byDay = new Map<number, { solved: boolean; finished: boolean; guesses: number; mode: string }>();
      for (const row of rows) {
        const day = unpadDay(String(row.day));
        if (day < first || day > last) continue;
        const guesses = parseJson<number[][]>(row.guesses, []).length;
        // Mode locks on first submit, so there is normally one session per day.
        // If both somehow exist, the finished one is the one worth showing.
        const existing = byDay.get(day);
        if (existing?.finished && !row.finished) continue;
        byDay.set(day, {
          solved: Boolean(row.solved),
          finished: Boolean(row.finished),
          guesses,
          mode: String(row.mode)
        });
      }

      const days = [];
      for (let day = last; day >= first; day--) {
        const entry = calendarDay(day);
        if (!entry) continue;
        const play = byDay.get(day) ?? null;
        days.push({
          day,
          stat: entry.stat,
          // The top repo is the answer's first slot. It only appears once the
          // game is over — otherwise the archive would hand out a fifth of the
          // board for every day a player has not finished.
          top: play?.finished ? REPOS[entry.answer[0]].slug : null,
          played: Boolean(play),
          finished: Boolean(play?.finished),
          solved: Boolean(play?.solved),
          guesses: play?.guesses ?? 0,
          budget: play ? BUDGET[play.mode as Mode] : 0,
          mode: play?.mode ?? null
        });
      }

      const prev = shiftMonth(ym, -1);
      const next = shiftMonth(ym, 1);

      return {
        month: monthSlug(ym),
        label: monthLabel(ym),
        current,
        days,
        prev: daysInMonth(prev).last >= 0 ? monthSlug(prev) : null,
        next: daysInMonth(next).first <= current ? monthSlug(next) : null,
        // Lifetime totals, so the header does not lie when paging back.
        totals: (() => {
          let played = 0;
          let solved = 0;
          for (const row of rows) {
            if (!row.finished) continue;
            played++;
            if (row.solved) solved++;
          }
          return { played, solved };
        })()
      };
    }),

    /** Global guess distribution for a finished day. */
    results: query(async (ctx, args: { day: number; mode: string }) => {
      if (!isMode(args?.mode) || !Number.isInteger(args?.day)) return { total: 0, buckets: {} };

      const rows = await ctx.db.results
        .withIndex("by_day_mode", (q) => q.eq("day", padDay(args.day)).eq("mode", args.mode))
        .collect();

      const buckets: Record<string, number> = {};
      for (const row of rows) {
        const b = String(row.bucket);
        buckets[b] = (buckets[b] ?? 0) + 1;
      }
      return { total: rows.length, buckets };
    })
  },

  mutations: {
    /**
     * Grade one ordering. This is the only place the answer exists.
     *
     * The session row is created lazily on the first submit, which is also what
     * locks the mode in — there is no separate start call to get out of sync.
     */
    submit: mutation(async (ctx, args: { clientKey: string; mode: string; order: number[]; day?: number }) => {
      const clientKey = typeof args?.clientKey === "string" ? args.clientKey.slice(0, 64) : "";
      if (!clientKey) return { ok: false as const, error: "missing clientKey" };
      if (!isMode(args?.mode)) return { ok: false as const, error: "bad mode" };
      if (!isPermutation(args?.order)) return { ok: false as const, error: "bad order" };

      // Same clamp as the query. Grading a future day would leak its answer one
      // guess at a time, so this is not merely a mirror of the read path.
      const resolved = resolveDay(args?.day);
      if (!resolved) return { ok: false as const, error: "bad day" };

      const mode = args.mode;
      const order = args.order;
      const { day, isArchive } = resolved;
      const puzzle = buildPuzzle(day);
      if (!puzzle) return { ok: false as const, error: "no puzzle for that day" };

      const budget = BUDGET[mode];

      const existing = await ctx.db.sessions
        .withIndex("by_client_day", (q) => q.eq("clientKey", clientKey).eq("day", padDay(day)))
        .collect();
      const row = existing.find((r) => r.mode === mode) ?? null;

      const guesses = parseJson<number[][]>(row?.guesses, []);
      const marks = parseJson<boolean[][]>(row?.marks, []);

      if (row?.finished) return { ok: false as const, error: "already finished" };

      // The real budget enforcement. The client keeps its own counter, but that
      // one is cosmetic — this is the check that actually holds.
      if (guesses.length >= budget) return { ok: false as const, error: "out of guesses" };

      // Locks are permanent, so an ordering that moves one is not a legal move.
      // Reaching here means a client bug or someone poking at the mutation.
      const locked = lockedSlots(guesses, marks);
      for (const [slot, item] of locked) {
        if (order[slot] !== item) return { ok: false as const, error: "moved a locked slot" };
      }

      const mark = grade(order, puzzle.answerItems);
      if (isImpossibleMarkCount(mark)) {
        // Four correct means the fifth has nowhere else to be. If this ever
        // fires, grading is broken — better to know than to render it.
        throw new Error(`grader produced ${SLOTS - 1} correct slots, which is impossible`);
      }

      guesses.push(order);
      marks.push(mark);

      const solved = mark.every(Boolean);
      const finished = solved || guesses.length >= budget;

      const patch = {
        guesses: JSON.stringify(guesses),
        marks: JSON.stringify(marks),
        solved,
        finished
      };

      if (row) {
        await ctx.db.sessions.update(row.id, patch);
      } else {
        await ctx.db.sessions.insert({ clientKey, day: padDay(day), mode, ...patch });
      }

      if (finished) {
        await ctx.db.results.insert({
          day: padDay(day),
          mode,
          bucket: solved ? String(guesses.length) : "X"
        });
      }

      return {
        ok: true as const,
        marks,
        guesses,
        solved,
        finished,
        isArchive,
        // Returned on the same call that ends the game, so the payoff does not
        // need a second round trip at the exact moment the player wants it.
        reveal: finished ? reveal(day) : null
      };
    })
  }
});
