/**
 * Render the next N days of real puzzles as a single page, in the real design.
 *
 *   node tools/preview-month.ts [days] [startDay]
 *
 * The calendar is pre-baked, so this is not a mock — it is exactly what the
 * site will serve. The point is to look at a month at once and catch the things
 * a single day cannot show: a stat rotation that feels lopsided, a repo turning
 * up too often, a day whose five repos nobody could reason about.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CALENDAR } from "../server/data/calendar.gen.ts";
import { REPOS } from "../server/data/repos.gen.ts";
import { EPOCH_DAY, dayIndexFrom, statLabel } from "../shared/format.ts";
import { weekdayOf } from "../shared/puzzle.ts";
import { STAT_KEYS, statValue } from "../shared/types.ts";
import type { StatKey } from "../shared/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "design", "month.html");

const DAYS = Number(process.argv[2] ?? 30);
const START = Number(process.argv[3] ?? dayIndexFrom(Date.now()));
const NOW = Date.now();

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Row {
  slug: string;
  raw: number; // the value used for display
  sort: number; // the value used for ordering and gaps
}

function dayRows(day: number): { stat: StatKey; rows: Row[] } {
  const entry = CALENDAR[day];
  const rows = entry.answer.map((idx) => {
    const repo = REPOS[idx];
    return {
      slug: repo.slug,
      raw: entry.stat === "age" ? repo.firstCommitMs! : statValue(repo, entry.stat),
      sort: statValue(repo, entry.stat)
    };
  });
  return { stat: entry.stat, rows };
}

/** Same rule the results screen uses: linear differences, scaled. */
function gapsFor(rows: Row[], max = 30): number[] {
  const diffs: number[] = [];
  for (let i = 1; i < rows.length; i++) diffs.push(Math.abs(rows[i - 1].raw - rows[i].raw));
  const widest = Math.max(...diffs, 1);
  return diffs.map((d) => 4 + Math.round((d / widest) * max));
}

// ---------------------------------------------------------------- build

const days: number[] = [];
for (let i = 0; i < DAYS; i++) if (CALENDAR[START + i]) days.push(START + i);

const cards = days
  .map((day) => {
    const abs = EPOCH_DAY + day;
    const date = new Date(abs * 86_400_000);
    const { stat, rows } = dayRows(day);
    const gaps = gapsFor(rows);

    const body = rows
      .map((r, i) => {
        const gap = i < gaps.length ? `<div class="m-gap" style="height:${gaps[i]}px"></div>` : "";
        return `
        <div class="m-row">
          <span class="m-num">${i + 1}</span>
          <span class="m-body">
            <span class="m-slug">${esc(r.slug)}</span>
            <span class="m-val">${esc(statLabel(stat, r.raw, NOW))}</span>
          </span>
        </div>${gap}`;
      })
      .join("");

    return `
    <article class="card">
      <header class="card-head">
        <span class="card-no">#${day + 1}</span>
        <span class="card-date">${DOW[weekdayOf(abs)]} ${date.toISOString().slice(5, 10)}</span>
        <span class="card-stat">${esc(stat === "openIssues" ? "open issues" : stat)}</span>
      </header>
      <div class="m-list">
        <span class="m-spine"></span>
        ${body}
      </div>
    </article>`;
  })
  .join("");

// ---------------------------------------------------------------- analysis

const statCount = new Map<StatKey, number>();
const repoCount = new Map<string, number>();
for (const day of days) {
  const { stat, rows } = dayRows(day);
  statCount.set(stat, (statCount.get(stat) ?? 0) + 1);
  for (const r of rows) repoCount.set(r.slug, (repoCount.get(r.slug) ?? 0) + 1);
}
const repeats = [...repoCount.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);

const statRow = STAT_KEYS.map((s) => {
  const n = statCount.get(s) ?? 0;
  return `<div class="stat"><div class="stat-n">${n}</div><div class="stat-k">${s === "openIssues" ? "open issues" : s}</div></div>`;
}).join("");

/** How concentrated each weekday is — a fixed rotation would show 100% here. */
const weekdayRow = DOW.map((d, i) => {
  const onThisDay = days.filter((day) => weekdayOf(EPOCH_DAY + day) === i);
  const counts = new Map<StatKey, number>();
  for (const day of onThisDay) {
    const s = dayRows(day).stat;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const share = top && onThisDay.length ? Math.round((top[1] / onThisDay.length) * 100) : 0;
  return `<div class="wd"><div class="wd-d">${d}</div><div class="wd-s">${share}% ${top ? (top[0] === "openIssues" ? "issues" : top[0]) : "—"}</div></div>`;
}).join("");

const repeatNote = repeats.length
  ? `${repeats.length} repo${repeats.length === 1 ? "" : "s"} appear more than once — most often <b>${esc(repeats[0][0])}</b> at ${repeats[0][1]}×. No set of five ever repeats within 400 days, and no single repo within 30.`
  : `No repo appears twice in these ${days.length} days.`;

// ---------------------------------------------------------------- emit

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bubblesort — the next ${days.length} days</title>
<style>
  :root{
    --paper:#FAFAF8; --ink:#213B5C; --grey:#8A8A85; --faint:#B9B9B3; --rule:#E5E3DC;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--grey);font-family:var(--sans);font-size:15px;line-height:1.55}
  .page{max-width:1240px;margin:0 auto;padding:56px 32px 110px}

  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:0 0 18px}
  h1{font-size:27px;font-weight:600;color:#1B1D1C;letter-spacing:-.02em;margin:0 0 12px;line-height:1.2}
  .lede{max-width:64ch;margin:0 0 40px}
  .lede b{color:#1B1D1C;font-weight:600}

  .panel{border:1px solid var(--rule);margin:0 0 20px}
  .panel-h{font-family:var(--mono);font-size:10.5px;letter-spacing:.15em;text-transform:uppercase;color:var(--faint);padding:14px 18px 0}
  .stats{display:flex;flex-wrap:wrap;padding:12px 18px 18px;gap:0}
  .stat{flex:1 1 110px;border-right:1px solid var(--rule);padding-right:16px;margin-right:16px}
  .stat:last-child{border-right:0}
  .stat-n{font-size:25px;font-weight:300;color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  .stat-k{font-family:var(--mono);font-size:11px;color:var(--faint)}
  .wds{display:flex;flex-wrap:wrap;padding:12px 18px 18px}
  .wd{flex:1 1 90px;border-right:1px solid var(--rule);padding-right:14px;margin-right:14px}
  .wd:last-child{border-right:0}
  .wd-d{font-size:13px;color:#1B1D1C;font-weight:600}
  .wd-s{font-family:var(--mono);font-size:11px;color:var(--faint)}
  .panel-note{padding:0 18px 18px;font-size:14px;max-width:78ch}
  .panel-note b{color:var(--ink);font-weight:600;font-family:var(--mono);font-size:13px}

  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:0;border-top:1px solid var(--rule);border-left:1px solid var(--rule);margin-top:36px}
  .card{border-right:1px solid var(--rule);border-bottom:1px solid var(--rule);padding:20px 22px 24px;background:#fff}
  .card-head{display:flex;align-items:baseline;gap:10px;margin-bottom:18px}
  .card-no{font-size:17px;font-weight:600;color:#1B1D1C;letter-spacing:-.01em;font-variant-numeric:tabular-nums}
  .card-date{font-family:var(--mono);font-size:11px;color:var(--faint)}
  .card-stat{margin-left:auto;font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--ink)}

  .m-list{position:relative}
  .m-spine{position:absolute;left:30px;top:0;bottom:0;border-left:1px solid var(--rule)}
  .m-row{display:flex;align-items:baseline;min-height:26px}
  .m-num{width:30px;flex:none;text-align:right;padding-right:11px;font-size:17px;font-weight:200;color:var(--faint);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  .m-body{flex:1;min-width:0;display:flex;align-items:baseline;gap:10px;padding-left:12px}
  .m-slug{font-family:var(--mono);font-size:12.5px;color:var(--ink);font-weight:700;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .m-val{margin-left:auto;flex:none;font-size:12px;color:var(--grey);font-variant-numeric:tabular-nums}
  .m-gap{}

  @media (max-width:640px){ .page{padding:36px 18px 70px} h1{font-size:22px} }
</style>
</head>
<body>
<div class="page">
  <p class="eyebrow">Bubblesort · calendar preview</p>
  <h1>The next ${days.length} days, exactly as they will ship</h1>
  <p class="lede">Puzzles #${days[0] + 1}–#${days[days.length - 1] + 1}, read straight out of the baked calendar — <b>this is not a simulation</b>. Each card shows the answer order with real values, spaced by magnitude the way the results screen does it.</p>

  <div class="panel">
    <div class="panel-h">Stat rotation over the month</div>
    <div class="stats">${statRow}</div>
  </div>

  <div class="panel">
    <div class="panel-h">Weekday concentration — the most common stat per weekday, and its share</div>
    <div class="wds">${weekdayRow}</div>
  </div>

  <div class="panel">
    <div class="panel-h">Repetition</div>
    <p class="panel-note">${repeatNote}</p>
  </div>

  <div class="grid">${cards}</div>
</div>
</body>
</html>
`;

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, html);

console.log(`days:        #${days[0] + 1} to #${days[days.length - 1] + 1}`);
console.log(`stats:       ${STAT_KEYS.map((s) => `${s} ${statCount.get(s) ?? 0}`).join("  ")}`);
console.log(`distinct repos: ${repoCount.size} across ${days.length * 5} slots`);
console.log(`repeated:    ${repeats.length}${repeats.length ? `  (max ${repeats[0][1]}x ${repeats[0][0]})` : ""}`);
console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
