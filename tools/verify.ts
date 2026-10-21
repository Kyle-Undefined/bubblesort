/**
 * End-to-end checks on the server's guarantees.
 *
 *   node tools/verify.ts
 *
 * `query()` and `mutation()` are identity functions in lakebed, so the real
 * handlers can be driven directly against a fake in-memory database. That means
 * these assertions run against the code that actually ships, not a reimplementation
 * of it — and they cover the things the UI cannot prove on its own, like whether
 * the server would still reject a guess submitted past the budget by someone
 * poking at the mutation from devtools.
 */

import capsule from "../server/index.ts";
import { CALENDAR } from "../server/data/calendar.gen.ts";
import { dayIndexFrom } from "../shared/format.ts";
import { BUDGET, SLOTS, weekdayOf } from "../shared/puzzle.ts";
import { isFairSet } from "./generate.ts";
import { EPOCH_DAY } from "../shared/format.ts";
import { REPOS } from "../server/data/repos.gen.ts";
import { STAT_KEYS, hasStat } from "../shared/types.ts";

// ---------------------------------------------------------------- fake db

interface Row extends Record<string, unknown> {
  id: string;
}

function makeDb(tables: string[]) {
  const store = new Map<string, Row[]>(tables.map((t) => [t, []]));
  let seq = 0;

  const api: Record<string, unknown> = {};
  for (const table of tables) {
    api[table] = {
      withIndex(_index: string, range?: (q: any) => any) {
        const clauses: { field: string; value: unknown }[] = [];
        const q: any = {
          eq(field: string, value: unknown) {
            clauses.push({ field, value });
            return q;
          }
        };
        range?.(q);
        const rows = store.get(table)!.filter((r) => clauses.every((c) => r[c.field] === c.value));
        return {
          collect: async () => rows,
          first: async () => rows[0] ?? null
        };
      },
      insert: async (value: Record<string, unknown>) => {
        const row: Row = { id: `${table}_${++seq}`, ...value };
        store.get(table)!.push(row);
        return row;
      },
      update: async (id: string, patch: Record<string, unknown>) => {
        const row = store.get(table)!.find((r) => r.id === id);
        if (row) Object.assign(row, patch);
        return row ?? null;
      }
    };
  }

  return { db: api, store };
}

const ctx = () => {
  const { db, store } = makeDb(["sessions", "results"]);
  return { ctx: { db } as any, store };
};

// ---------------------------------------------------------------- harness

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed++;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const submit = capsule.mutations.submit as any;
const today = capsule.queries.today as any;
const results = capsule.queries.results as any;

const KEY = "verify-client-key";
const day = dayIndexFrom(Date.now());

/** Read the answer out of the calendar the same way the server does. */
function answerOrderForToday(): number[] {
  const entry = CALENDAR[day];
  return entry.answer.map((repoIdx) => entry.shown.indexOf(repoIdx));
}

// ---------------------------------------------------------------- checks

console.log("\ncalendar integrity");
{
  check("calendar covers today", Boolean(CALENDAR[day]), `day ${day}`);
  check(
    "every day is dense and self-consistent",
    CALENDAR.every((d, i) => d.day === i)
  );
  check(
    "every answer is a permutation of its shown set",
    CALENDAR.every(
      (d) =>
        d.answer.length === SLOTS &&
        d.shown.length === SLOTS &&
        new Set(d.answer).size === SLOTS &&
        d.answer.slice().sort().join() === d.shown.slice().sort().join()
    )
  );
  const freeLock = CALENDAR.filter((d) => d.shown.some((v, i) => v === d.answer[i]));
  check("no puzzle opens with a free lock", freeLock.length === 0, `${freeLock.length} bad days`);
  const unfair = CALENDAR.filter((d) => !isFairSet(d.answer.map((i) => REPOS[i]), d.stat));
  check("every puzzle satisfies the gap rule", unfair.length === 0, `${unfair.length} bad days`);
  // The stat rotation deals from a bag holding each stat twice, refilled every
  // ten days, so these are the properties that replace "matches the weekday
  // table": exact balance per block, and never the same stat twice running.
  const BLOCK = STAT_KEYS.length * 2;
  let unbalanced = 0;
  for (let start = 0; start + BLOCK <= CALENDAR.length; start += BLOCK) {
    const counts = new Map<string, number>();
    for (let i = start; i < start + BLOCK; i++) {
      counts.set(CALENDAR[i].stat, (counts.get(CALENDAR[i].stat) ?? 0) + 1);
    }
    if (STAT_KEYS.some((s) => counts.get(s) !== 2)) unbalanced++;
  }
  check("every block of ten uses each stat exactly twice", unbalanced === 0, `${unbalanced} bad blocks`);

  const backToBack = CALENDAR.filter((d, i) => i > 0 && d.stat === CALENDAR[i - 1].stat);
  check("no stat lands two days running", backToBack.length === 0, `${backToBack.length} repeats`);

  // The old table pinned each weekday to one stat. Nothing should now.
  let worstWeekday = 0;
  for (let w = 0; w < 7; w++) {
    const onThisDay = CALENDAR.filter((d) => weekdayOf(EPOCH_DAY + d.day) === w);
    const counts = new Map<string, number>();
    for (const d of onThisDay) counts.set(d.stat, (counts.get(d.stat) ?? 0) + 1);
    worstWeekday = Math.max(worstWeekday, Math.max(...counts.values()) / onThisDay.length);
  }
  check(
    "no weekday is dominated by one stat",
    worstWeekday < 0.5,
    `most predictable weekday is ${(worstWeekday * 100).toFixed(0)}% one stat`
  );
  const missing = CALENDAR.filter((d) => d.answer.some((i) => !hasStat(REPOS[i], d.stat)));
  check("no puzzle uses a repo missing that stat", missing.length === 0, `${missing.length} bad days`);
}

console.log("\nbudget enforcement (hard = 3)");
{
  const { ctx: c, store } = ctx();
  const wrong = [1, 0, 2, 3, 4];
  const results: any[] = [];
  // Deliberately overshoot the budget, the way a devtools poke would.
  for (let i = 0; i < BUDGET.hard + 3; i++) {
    results.push(await submit(c, { clientKey: KEY, mode: "hard", order: wrong }));
  }

  const accepted = results.filter((r) => r.ok).length;
  check("server accepts exactly the budget", accepted === BUDGET.hard, `accepted ${accepted}`);
  check(
    "extra submissions are rejected",
    results.slice(BUDGET.hard).every((r) => !r.ok),
    results[BUDGET.hard]?.error
  );
  check("exactly one results row is written", store.get("results")!.length === 1);
  check("the game is marked finished", Boolean(results[BUDGET.hard - 1].finished));
  check("a loss is bucketed as X", store.get("results")![0].bucket === "X");
}

console.log("\nanswer secrecy");
{
  const { ctx: c } = ctx();
  const wrong = [1, 0, 2, 3, 4];

  const first = await submit(c, { clientKey: KEY, mode: "easy", order: wrong });
  check("no reveal while the game is live", first.reveal === null);

  const view = await today(c, { clientKey: KEY });
  check("today query never carries a stat value mid-game", view.sessions.easy.reveal === null);
  check(
    "today query never carries the answer",
    !JSON.stringify(view).includes("answer") && !JSON.stringify(view).includes("firstCommitMs")
  );

  // Burn the rest of the budget and confirm the payoff arrives exactly once.
  let last: any;
  for (let i = 1; i < BUDGET.easy; i++) {
    last = await submit(c, { clientKey: KEY, mode: "easy", order: wrong });
  }
  check("reveal arrives on the call that ends the game", Array.isArray(last.reveal) && last.reveal.length === SLOTS);
  check(
    "reveal is sorted best-first",
    last.reveal.every((r: any, i: number, a: any[]) =>
      i === 0 || (CALENDAR[day].stat === "age" ? a[i - 1].value <= r.value : a[i - 1].value >= r.value)
    )
  );
}

console.log("\nlocked slots are permanent");
{
  const { ctx: c } = ctx();
  const answer = answerOrderForToday();
  // A guess that gets slot 0 right, so it locks.
  const seed = answer.slice();
  [seed[1], seed[2]] = [seed[2], seed[1]];

  const first = await submit(c, { clientKey: KEY, mode: "easy", order: seed });
  const lockedAt = first.marks[0].findIndex(Boolean);
  check("a correct slot locks", lockedAt !== -1);

  if (lockedAt !== -1) {
    const moved = seed.slice();
    const other = lockedAt === 0 ? 1 : 0;
    [moved[lockedAt], moved[other]] = [moved[other], moved[lockedAt]];
    const res = await submit(c, { clientKey: KEY, mode: "easy", order: moved });
    check("moving a locked slot is rejected", !res.ok, res.error);
  }
}

console.log("\nmalformed input");
{
  const { ctx: c } = ctx();
  const bad: [string, unknown][] = [
    ["not an array", "12345"],
    ["wrong length", [0, 1, 2]],
    ["duplicate entries", [0, 0, 1, 2, 3]],
    ["out of range", [0, 1, 2, 3, 9]],
    ["non-integer", [0, 1, 2, 3, 4.5]]
  ];
  for (const [label, order] of bad) {
    const res = await submit(c, { clientKey: KEY, mode: "easy", order });
    check(`rejects ${label}`, !res.ok);
  }
  check("rejects an unknown mode", !(await submit(c, { clientKey: KEY, mode: "medium", order: [0, 1, 2, 3, 4] })).ok);
  check("rejects a missing clientKey", !(await submit(c, { clientKey: "", mode: "easy", order: [0, 1, 2, 3, 4] })).ok);
}

console.log("\narchive day clamp");
{
  const { ctx: c } = ctx();
  const good = [0, 1, 2, 3, 4];

  // The calendar is baked ~1,100 days ahead. If a day parameter were trusted,
  // every one of those future puzzles would be readable today, so these are the
  // checks that actually matter for the archive.
  const future = [day + 1, day + 7, day + 500, CALENDAR.length - 1];
  check(
    "query refuses every future day",
    (await Promise.all(future.map((d) => today(c, { clientKey: KEY, day: d })))).every((r) => !r.ready),
    `tried ${future.join(", ")}`
  );
  check(
    "submit refuses every future day",
    (await Promise.all(future.map((d) => submit(c, { clientKey: KEY, mode: "easy", order: good, day: d })))).every(
      (r) => !r.ok
    )
  );

  check("query refuses a negative day", !(await today(c, { clientKey: KEY, day: -1 })).ready);
  check("submit refuses a negative day", !(await submit(c, { clientKey: KEY, mode: "easy", order: good, day: -1 })).ok);
  check("query refuses a non-integer day", !(await today(c, { clientKey: KEY, day: 1.5 })).ready);
  check("query refuses a garbage day", !(await today(c, { clientKey: KEY, day: "3" as any })).ready);

  const now = await today(c, { clientKey: KEY });
  check("omitting the day gives today", now.day === day && now.isArchive === false);

  if (day >= 1) {
    const past = await today(c, { clientKey: KEY, day: day - 1 });
    check("a past day is served", past.ready === true);
    check("a past day is flagged as archive", past.isArchive === true);
    check(
      "a past day serves its own puzzle",
      past.stat === CALENDAR[day - 1].stat &&
        past.items.length === SLOTS &&
        past.items.every((it: any, i: number) => it.slug === REPOS[CALENDAR[day - 1].shown[i]].slug)
    );
    check("a past day still hides its values", past.sessions.easy === undefined || past.sessions.easy.reveal === null);

    const played = await submit(c, { clientKey: KEY, mode: "easy", order: good, day: day - 1 });
    check("a past day is playable", played.ok === true);
    check("a past day reports itself as archive", played.isArchive === true);
  } else {
    console.log("  skip  past-day checks (today is puzzle #1)");
  }
}

console.log("\narchive index");
{
  const { ctx: c } = ctx();
  const archive = capsule.queries.archive as any;

  const before = await archive(c, { clientKey: KEY });
  check("returns the current month by default", before.month === new Date().toISOString().slice(0, 7));
  check(
    "an unplayed day never names its top repo",
    before.days.every((d: any) => d.played || d.top === null)
  );

  // Start a game but do not finish it.
  await submit(c, { clientKey: KEY, mode: "easy", order: [1, 0, 2, 3, 4] });
  const mid = await archive(c, { clientKey: KEY });
  const todayRow = mid.days.find((d: any) => d.day === day);
  check("an in-progress day is marked played but unfinished", todayRow?.played && !todayRow?.finished);
  check(
    "an unfinished day still hides its top repo",
    mid.days.every((d: any) => d.finished || d.top === null),
    "leaking the answer's first slot would give away a fifth of the board"
  );

  // Finish it.
  for (let i = 1; i < BUDGET.easy; i++) await submit(c, { clientKey: KEY, mode: "easy", order: [1, 0, 2, 3, 4] });
  const after = await archive(c, { clientKey: KEY });
  const done = after.days.find((d: any) => d.day === day);
  check("a finished day reveals its top repo", typeof done?.top === "string");
  check("a finished day reports guesses and budget", done?.guesses === BUDGET.easy && done?.budget === BUDGET.easy);
  check("lifetime totals count finished games", after.totals.played === 1);

  check("a malformed month falls back rather than erroring", (await archive(c, { clientKey: KEY, month: "nope" })).days !== undefined);
  check("paging stops before the calendar starts", (await archive(c, { clientKey: KEY, month: "2020-01" })).prev === null);
  const future = await archive(c, { clientKey: KEY, month: "2099-01" });
  check("a future month is empty", future.days.length === 0);
  check("a future month offers no later page", future.next === null);
}

console.log("\nwinning");
{
  const { ctx: c, store } = ctx();
  const res = await submit(c, { clientKey: KEY, mode: "hard", order: answerOrderForToday() });
  check("the correct order solves", Boolean(res.solved));
  check("a win finishes the game", Boolean(res.finished));
  check("a win reveals the values", Array.isArray(res.reveal));
  check("a win is bucketed by guess count", store.get("results")![0].bucket === "1");
}

console.log("\nglobal distribution");
{
  const { ctx: c } = ctx();
  const answer = answerOrderForToday();

  await submit(c, { clientKey: `${KEY}-easy`, mode: "easy", order: answer });
  await submit(c, { clientKey: `${KEY}-hard`, mode: "hard", order: answer });

  const easy = await results(c, { day, mode: "easy" });
  const hard = await results(c, { day, mode: "hard" });
  check("distribution counts finished games", easy.total === 1 && easy.buckets["1"] === 1);
  check("distribution keeps modes separate", hard.total === 1 && hard.buckets["1"] === 1);

  const invalid = await results(c, { day, mode: "medium" });
  check("distribution rejects an unknown mode", invalid.total === 0 && Object.keys(invalid.buckets).length === 0);
}

// ---------------------------------------------------------------- report

console.log(`\n${"-".repeat(56)}`);
if (failures.length === 0) {
  console.log(`${passed} checks passed.`);
} else {
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
