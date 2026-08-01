// Formatting and encoding helpers shared by server and client.
// Pure TS: no DOM, no Node, no lakebed imports.

import type { StatKey } from "./types.ts";

// ---------------------------------------------------------------- day index

/**
 * Day 0 — Bubblesort #1.
 *
 * Deliberately a week before launch. With the epoch on launch day the archive
 * opens holding a single puzzle, and its first page of history is one row,
 * which reads as broken rather than new. Starting the numbering a week earlier
 * means there is a back catalogue to explore from the first visit.
 *
 * Must not be in the future: `dayIndexFrom` would go negative, there is no
 * calendar entry for a negative day, and the site would serve "no puzzle today"
 * until the date arrived.
 */
export const EPOCH_DAY = Math.floor(Date.parse("2026-07-25T00:00:00Z") / 86_400_000);

/** Days since epoch, UTC. One puzzle, one global clock — rollover is midnight UTC. */
export function dayIndexFrom(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000) - EPOCH_DAY;
}

/** Milliseconds until the next UTC midnight, for the countdown on the results screen. */
export function msUntilNextDay(nowMs: number): number {
  return 86_400_000 - (nowMs % 86_400_000);
}

// ---------------------------------------------------------------- months
//
// The archive pages by calendar month rather than by a fixed row count, so each
// page names itself — "August" is something a player can hold in their head,
// "puzzles 21 to 35" is not.

export interface YearMonth {
  year: number;
  month: number; // 1-12
}

/** The UTC calendar month a day index falls in. */
export function monthOfDay(day: number): YearMonth {
  const d = new Date((EPOCH_DAY + day) * 86_400_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 };
}

const DOW_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The calendar date a day index lands on.
 *
 * The archive pages by month, so its rows are indexed by date rather than by
 * puzzle number — on a page headed "July 2026", a column reading 31, 30, 29 is
 * a calendar, while 7, 6, 5 just looks like a row count.
 */
export function calendarDate(day: number): { dom: number; dow: string } {
  const d = new Date((EPOCH_DAY + day) * 86_400_000);
  return { dom: d.getUTCDate(), dow: DOW_SHORT[d.getUTCDay()] };
}

/** First and last day index of a calendar month. May fall outside the calendar. */
export function daysInMonth(ym: YearMonth): { first: number; last: number } {
  const first = Math.floor(Date.UTC(ym.year, ym.month - 1, 1) / 86_400_000) - EPOCH_DAY;
  const last = Math.floor(Date.UTC(ym.year, ym.month, 1) / 86_400_000) - EPOCH_DAY - 1;
  return { first, last };
}

export function shiftMonth(ym: YearMonth, by: number): YearMonth {
  const m = ym.month - 1 + by;
  return { year: ym.year + Math.floor(m / 12), month: ((m % 12) + 12) % 12 + 1 };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"
];

export function monthLabel(ym: YearMonth): string {
  return `${MONTH_NAMES[ym.month - 1]} ${ym.year}`;
}

/** "2026-08" — the archive's URL segment. */
export function monthSlug(ym: YearMonth): string {
  return `${ym.year}-${String(ym.month).padStart(2, "0")}`;
}

export function parseMonthSlug(slug: string): YearMonth | null {
  const m = /^(\d{4})-(\d{2})$/.exec(slug);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year, month };
}

// ---------------------------------------------------------------- db encoding

/**
 * The lakebed schema has no number type — `lakebed/server` exports exactly
 * string(), boolean(), id() and table(). Any number that needs to sort or range
 * correctly through `withIndex` therefore has to be a zero-padded string.
 *
 * Every numeric column goes through these two helpers rather than an ad-hoc
 * String(n) at the call site, so the padding width can never drift between
 * writer and reader.
 */
const DAY_WIDTH = 6;

export function padDay(day: number): string {
  if (!Number.isInteger(day)) throw new Error(`day must be an integer, got ${day}`);
  // Negative days would break lexicographic ordering entirely. They can only
  // happen if someone loads the site before EPOCH_DAY, which is a bug worth
  // failing loudly on rather than silently storing a corrupt key.
  if (day < 0) throw new Error(`day must not be negative, got ${day}`);
  return String(day).padStart(DAY_WIDTH, "0");
}

export function unpadDay(padded: string): number {
  return Number(padded);
}

// ---------------------------------------------------------------- display

/** 1234 -> "1,234". Plain and unambiguous; no k/M abbreviation on the results screen. */
export function comma(n: number): string {
  return n.toLocaleString("en-US");
}

/** First-commit timestamp -> "18 years old", for the age stat. */
export function ageLabel(firstCommitMs: number, nowMs: number): string {
  const years = (nowMs - firstCommitMs) / (365.2425 * 86_400_000);
  if (years < 1) {
    const months = Math.max(1, Math.round(years * 12));
    return `${months} month${months === 1 ? "" : "s"} old`;
  }
  const whole = Math.floor(years);
  return `${whole} year${whole === 1 ? "" : "s"} old`;
}

/** The value shown next to a repo on the results screen. */
export function statLabel(stat: StatKey, value: number, nowMs: number): string {
  if (stat === "age") return ageLabel(value, nowMs);
  return comma(value);
}
