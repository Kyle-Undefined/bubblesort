/**
 * Mock the archive index against real calendar data.
 *
 *   node tools/preview-archive.ts
 *
 * Today the archive is reachable only through prev/next arrows in the footer,
 * which is fine for "yesterday" and useless for "the one about contributors two
 * weeks ago". This renders two candidate layouts over a real month so they can
 * be compared with actual repo names and stats rather than lorem.
 *
 * Play results are simulated — nothing else on the page is.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CALENDAR } from "../server/data/calendar.gen.ts";
import { REPOS } from "../server/data/repos.gen.ts";
import { EPOCH_DAY, dayIndexFrom } from "../shared/format.ts";
import { weekdayOf } from "../shared/puzzle.ts";
import { statSchedule } from "./generate.ts";
import { mulberry32 } from "../shared/rng.ts";
import type { StatKey } from "../shared/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "design", "archive.html");

/**
 * Which day to pretend it is. The real answer is 1, which makes for a very
 * short archive, so this defaults to a month in — the first point at which the
 * screen has to do any actual work.
 */
const TODAY = Number(process.argv[2] ?? Math.max(dayIndexFrom(Date.now()), 34));
const SPAN = 34; // a bit more than a month, so the list has to scroll
const FIRST = Math.max(0, TODAY - SPAN + 1);

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const label = (s: StatKey) => (s === "openIssues" ? "open issues" : s);

/** Stats under the proposed rotation, so the mock shows what would actually ship. */
const schedule = statSchedule(TODAY + 400);

interface Play {
  played: boolean;
  solved: boolean;
  guesses: number;
  mode: "easy" | "hard";
}

// Simulated history: mostly played, mostly solved, a few gaps and losses.
const rng = mulberry32(0xa11ce);
const plays = new Map<number, Play>();
for (let d = FIRST; d <= TODAY; d++) {
  const r = rng();
  if (r < 0.18) continue; // never played
  const mode = rng() < 0.35 ? "hard" : "easy";
  const budget = mode === "hard" ? 3 : 5;
  const solved = rng() < (mode === "hard" ? 0.72 : 0.94);
  const guesses = solved ? 2 + Math.floor(rng() * (budget - 1)) : budget;
  plays.set(d, { played: true, solved, guesses, mode });
}

const streakNow = (() => {
  let n = 0;
  for (let d = TODAY; d >= FIRST; d--) {
    const p = plays.get(d);
    if (p?.solved) n++;
    else break;
  }
  return n;
})();

// ---------------------------------------------------------------- layout A

const listRows = [];
for (let d = TODAY; d >= FIRST; d--) {
  const p = plays.get(d);
  const abs = EPOCH_DAY + d;
  const date = new Date(abs * 86_400_000).toISOString().slice(5, 10);
  // The day's top repo is the first slot of the answer. Showing it for a day
  // the player has not finished would hand them a fifth of the board for free,
  // so it only appears once the game is over.
  const entry = CALENDAR[d];
  const top = p && entry ? REPOS[entry.answer[0]].slug : "";

  const result = !p
    ? `<span class="a-unplayed">not played</span>`
    : p.solved
      ? `<span class="a-score">${p.guesses}/${p.mode === "hard" ? 3 : 5}</span>`
      : `<span class="a-miss">missed</span>`;

  listRows.push(`
    <a class="a-row${p ? "" : " is-open"}${d === TODAY ? " is-today" : ""}" href="#">
      <span class="a-num">${d + 1}</span>
      <span class="a-body">
        <span class="a-stat">${esc(label(schedule[d]))}</span>
        <span class="a-meta">${DOW[weekdayOf(abs)]} ${date}${d === TODAY ? " · today" : ""}</span>
        <span class="a-top">${esc(top)}</span>
        ${result}
      </span>
    </a>`);
}

// ---------------------------------------------------------------- layout B

const cells = [];
// pad so the grid starts on the right weekday
const padStart = weekdayOf(EPOCH_DAY + FIRST);
for (let i = 0; i < padStart; i++) cells.push(`<span class="g-cell is-pad"></span>`);
for (let d = FIRST; d <= TODAY; d++) {
  const p = plays.get(d);
  const cls = !p ? "is-open" : p.solved ? "is-won" : "is-lost";
  const mark = p?.solved ? String(p.guesses) : p ? "×" : "";
  cells.push(
    `<span class="g-cell ${cls}${d === TODAY ? " is-today" : ""}" title="#${d + 1} · ${label(schedule[d])}">
       <span class="g-no">${d + 1}</span><span class="g-mark">${mark}</span>
     </span>`
  );
}

const played = [...plays.values()].length;
const won = [...plays.values()].filter((p) => p.solved).length;

// ---------------------------------------------------------------- emit

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bubblesort — archive layouts</title>
<style>
  :root{
    --paper:#FAFAF8;--ink:#213B5C;--grey:#8A8A85;--faint:#B9B9B3;--rule:#E5E3DC;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--grey);font-family:var(--sans);font-size:15px;line-height:1.55}
  .page{max-width:1080px;margin:0 auto;padding:56px 32px 110px}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);margin:0 0 18px}
  h1{font-size:27px;font-weight:600;color:#1B1D1C;letter-spacing:-.02em;margin:0 0 12px;line-height:1.2}
  .lede{max-width:66ch;margin:0 0 48px}
  .lede b{color:#1B1D1C;font-weight:600}

  .opt{margin:0 0 72px}
  .opt-h{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;border-bottom:1px solid var(--rule);padding-bottom:12px;margin-bottom:30px}
  .opt-l{font-family:var(--mono);font-size:12px;letter-spacing:.14em;color:var(--ink);text-transform:uppercase}
  .opt-n{font-size:20px;font-weight:600;color:#1B1D1C;letter-spacing:-.015em}
  .opt-i{color:var(--grey);margin-left:auto;font-size:14.5px;max-width:46ch}
  .frame{background:#fff;border:1px solid var(--rule);padding:34px 30px 30px;max-width:470px}
  .note{margin-top:16px;font-size:14.5px;max-width:66ch}
  .note b{color:#1B1D1C;font-weight:600}

  /* header inside the frame */
  .f-eye{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);margin:0 0 4px}
  .f-title{font-size:19px;font-weight:500;color:#1B1D1C;letter-spacing:-.01em;margin:0 0 4px}
  .f-sub{font-size:14px;color:var(--faint);margin:0 0 26px}

  /* ---- A: ledger list ---- */
  .a-list{position:relative}
  .a-spine{position:absolute;left:52px;top:0;bottom:0;border-left:1px solid var(--rule)}
  .a-row{display:flex;align-items:baseline;min-height:54px;text-decoration:none;color:inherit}
  .a-num{width:52px;flex:none;text-align:right;padding-right:18px;font-size:24px;font-weight:200;color:var(--faint);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  .a-body{flex:1;min-width:0;padding-left:18px;display:grid;grid-template-columns:1fr auto;gap:0 12px;padding-bottom:14px}
  .a-stat{font-size:15px;color:var(--ink);font-weight:600;grid-column:1;letter-spacing:-.01em}
  .a-meta{font-family:var(--mono);font-size:11px;color:var(--faint);grid-column:1;grid-row:2}
  .a-top{font-family:var(--mono);font-size:11px;color:var(--faint);grid-column:1;grid-row:3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .a-score{grid-column:2;grid-row:1;font-variant-numeric:tabular-nums;color:var(--ink);font-weight:600}
  .a-miss{grid-column:2;grid-row:1;color:var(--faint)}
  .a-unplayed{grid-column:2;grid-row:1;font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink)}
  .a-row.is-open .a-stat{color:var(--grey);font-weight:400}
  .a-row.is-today .a-num{color:var(--ink);font-weight:300}

  /* ---- B: grid ---- */
  .g-head{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:8px}
  .g-dow{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint);text-align:center}
  .g-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px}
  .g-cell{aspect-ratio:1;border:1px solid var(--rule);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px}
  .g-cell.is-pad{border:0}
  .g-no{font-family:var(--mono);font-size:9.5px;color:var(--faint);line-height:1}
  .g-mark{font-size:15px;font-weight:600;color:var(--ink);font-variant-numeric:tabular-nums;line-height:1}
  .g-cell.is-open{background:repeating-linear-gradient(135deg,transparent,transparent 4px,#F1EFE9 4px,#F1EFE9 5px)}
  .g-cell.is-lost .g-mark{color:var(--faint);font-weight:400}
  .g-cell.is-won{border-color:#C9D2DC}
  .g-cell.is-today{border-color:var(--ink)}
  .g-legend{display:flex;gap:18px;margin-top:20px;font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}

  .summary{display:flex;gap:26px;margin-top:26px;padding-top:18px;border-top:1px solid var(--rule)}
  .s-n{font-size:22px;font-weight:300;color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
  .s-k{font-family:var(--mono);font-size:10.5px;letter-spacing:.1em;text-transform:uppercase;color:var(--faint)}

  @media (max-width:700px){.page{padding:36px 18px 70px}.opt-i{margin-left:0}}
</style>
</head>
<body>
<div class="page">
  <p class="eyebrow">Bubblesort · archive</p>
  <h1>Two ways into the back catalogue</h1>
  <p class="lede">Right now the only way to reach an old puzzle is stepping backwards one arrow at a time. That works for yesterday and falls apart for <b>"the contributors one from two weeks ago"</b>. Both layouts below use the real calendar and the proposed stat rotation; only the play results are invented.</p>

  <section class="opt">
    <div class="opt-h">
      <span class="opt-l">A</span>
      <span class="opt-n">Ledger list</span>
      <span class="opt-i">The archive is another ranked list, so it uses the board's own frame — same gutter, same spine.</span>
    </div>
    <div class="frame">
      <p class="f-eye">archive</p>
      <p class="f-title">${played} played · ${Math.round((won / played) * 100)}% solved</p>
      <p class="f-sub">${streakNow} day streak</p>
      <div class="a-list">
        <span class="a-spine"></span>
        ${listRows.join("")}
      </div>
    </div>
    <p class="note"><b>Why it fits.</b> Nothing new is invented — it is the board's frame reused, so the archive reads as part of the same object. Each row carries the stat, the date and the day's top repo, which is enough to recognise a puzzle you have played and enough to tempt you into one you have not. <b>Cost:</b> one row per day means a year is a long scroll, and it needs a server query for all of a player's sessions, which today's indexes do not support.</p>
  </section>

  <section class="opt">
    <div class="opt-h">
      <span class="opt-l">B</span>
      <span class="opt-n">Month grid</span>
      <span class="opt-i">A calendar. Dense, scannable, and the shape of your habit is visible at a glance.</span>
    </div>
    <div class="frame">
      <p class="f-eye">archive</p>
      <p class="f-title">August</p>
      <p class="f-sub">${streakNow} day streak</p>
      <div class="g-head">${DOW.map((d) => `<span class="g-dow">${d[0]}</span>`).join("")}</div>
      <div class="g-grid">${cells.join("")}</div>
      <div class="g-legend"><span>number = guesses used</span><span>× missed</span><span>hatched = unplayed</span></div>
      <div class="summary">
        <span><span class="s-n">${played}</span><br><span class="s-k">played</span></span>
        <span><span class="s-n">${won}</span><br><span class="s-k">solved</span></span>
        <span><span class="s-n">${streakNow}</span><br><span class="s-k">streak</span></span>
      </div>
    </div>
    <p class="note"><b>Why it fits.</b> A daily game is a calendar habit, and this is the only layout that shows the habit itself — the gaps are as legible as the wins. Scales to years without scrolling. <b>Cost:</b> it introduces a grid, which is the first boxed structure anywhere in the product, and a cell has room for a number but not for which stat the day was — so you cannot find "the contributors one" without opening days.</p>
  </section>
</div>
</body>
</html>
`;

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, html);
console.log(`days #${FIRST + 1}–#${TODAY + 1}, ${played} played, ${won} solved`);
console.log(`wrote ${path.relative(ROOT, OUT)}`);
