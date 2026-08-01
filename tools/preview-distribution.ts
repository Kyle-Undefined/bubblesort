/**
 * Three ways to render the global guess distribution.
 *
 *   node tools/preview-distribution.ts
 *
 * The `results` query already returns { total, buckets } and nothing draws it.
 * This is the one screen where the design has to represent a QUANTITY — every
 * other surface only ever shows rank, state, or a literal value — so it is
 * worth looking at before committing.
 *
 * Numbers here are invented but shaped like the solver's real output: mean
 * around 3, a long-ish tail, and a failure rate that is small on Easy and very
 * much not on Hard.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BUDGET } from "../shared/puzzle.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "design", "distribution.html");

// The live palette.
const PAPER = "#E7E9EC";
const INK = "#24405A";
const GREY = "#666A6D";
const NUMERAL = "#83868A";
const RULE = "#CDCFD2";
const GUTTER = 52;

interface Dist {
  mode: "easy" | "hard";
  buckets: Record<string, number>;
  you: string;
}

/** Easy: nearly everyone finishes. Hard: a third of people do not. */
const EASY: Dist = {
  mode: "easy",
  buckets: { "1": 41, "2": 388, "3": 902, "4": 631, "5": 274, X: 148 },
  you: "3"
};
const HARD: Dist = {
  mode: "hard",
  buckets: { "1": 18, "2": 214, "3": 402, X: 361 },
  you: "2"
};

/** Launch morning. This is the state the live database is in right now. */
const TINY: Dist = {
  mode: "easy",
  buckets: { "1": 0, "2": 1, "3": 1, "4": 1, "5": 0, X: 0 },
  you: "3"
};

const keys = (d: Dist) => [...Array.from({ length: BUDGET[d.mode] }, (_, i) => String(i + 1)), "X"];
const total = (d: Dist) => Object.values(d.buckets).reduce((a, b) => a + b, 0);
const pct = (n: number, t: number) => (t ? Math.round((n / t) * 100) : 0);

// ---------------------------------------------------------------- treatments

/** A — bars. The distribution is a ranked list, so it reuses the board's frame. */
function bars(d: Dist) {
  const t = total(d);
  const peak = Math.max(...Object.values(d.buckets));
  return keys(d)
    .map((k) => {
      const n = d.buckets[k] ?? 0;
      const mine = k === d.you;
      const w = peak ? Math.round((n / peak) * 100) : 0;
      // The bar lives in its own track so a 100% row cannot shove its
      // percentage off the edge of the card.
      return `
      <div class="row" style="height:36px">
        <span class="num" style="font-size:19px;color:${mine ? INK : NUMERAL};font-weight:${mine ? 400 : 200}">${k}</span>
        <span class="body">
          <span class="track"><span class="bar" style="width:${w}%;background:${mine ? INK : RULE}"></span></span>
          <span class="pc" style="color:${mine ? INK : GREY};font-weight:${mine ? 700 : 400}">${pct(n, t)}%</span>
        </span>
      </div>`;
    })
    .join("");
}

/** B — numbers only. Adds no new shape to a product that has none. */
function numbers(d: Dist) {
  const t = total(d);
  return keys(d)
    .map((k) => {
      const n = d.buckets[k] ?? 0;
      const mine = k === d.you;
      return `
      <div class="row" style="height:34px">
        <span class="num" style="font-size:19px;color:${mine ? INK : NUMERAL};font-weight:${mine ? 400 : 200}">${k}</span>
        <span class="body">
          <span class="lbl" style="color:${mine ? INK : GREY};font-weight:${mine ? 700 : 400}">${
            k === "X" ? "did not finish" : `${k} guess${k === "1" ? "" : "es"}`
          }</span>
          <span class="pc" style="color:${mine ? INK : GREY};font-weight:${mine ? 700 : 400}">${pct(n, t)}%</span>
        </span>
      </div>`;
    })
    .join("");
}

/** C — one sentence. The smallest thing that still says "you are not alone". */
/** Below this, percentages are theatre — 33% of three people is one person. */
const CROWD = 20;

function sentence(d: Dist) {
  const t = total(d);
  const mine = d.buckets[d.you] ?? 0;
  const best = keys(d).reduce((a, b) => ((d.buckets[b] ?? 0) > (d.buckets[a] ?? 0) ? b : a));

  // At low volume the honest move is to count, not to compute a share. It also
  // reads better: being third to finish is more interesting than being 33%.
  if (t < CROWD) {
    const others = t - 1;
    return `
    <p class="one" style="color:${GREY}">
      ${
        others <= 0
          ? `<b style="color:${INK}">First</b> to finish today.`
          : `You are one of <b style="color:${INK}">${t}</b> who have played today.`
      }
    </p>`;
  }

  // Naming the most common score is only worth saying when it is not yours —
  // otherwise the line tells you your own score twice.
  const tail =
    best === d.you
      ? `, the most common score today`
      : `. Most people took ${best === "X" ? "more than that" : best}`;

  return `
    <p class="one" style="color:${GREY}">
      <b style="color:${INK}">${pct(mine, t)}%</b> also solved it in ${d.you}${tail}.
      ${t.toLocaleString("en-US")} played.
    </p>`;
}

// ---------------------------------------------------------------- emit

// `spine` is off for the one-line treatment: there is no gutter to mark when
// the whole block is a sentence, and the rule just cut through the text.
const block = (title: string, note: string, inner: string, spine = true) => `
  <section class="opt">
    <div class="oh"><span class="on">${title}</span><span class="oi">${note}</span></div>
    <div class="pair">
      <div class="screen">
        <p class="eye">order by</p>
        <p class="head">stars, most first</p>
        <p class="status">solved in 3</p>
        <div class="list">${spine ? '<span class="spine"></span>' : ""}${inner}</div>
        <div class="foot"><span class="go">share</span><span class="cd">next in 06:12:44</span></div>
      </div>
    </div>
  </section>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bubblesort — guess distribution</title>
<style>
  :root{--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
        --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:#F5F6F7;color:${GREY};font-family:var(--sans);font-size:15px;line-height:1.55}
  .page{max-width:1080px;margin:0 auto;padding:56px 32px 110px}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${NUMERAL};margin:0 0 18px}
  h1{font-size:27px;font-weight:600;color:#1B1D1C;letter-spacing:-.02em;margin:0 0 12px;line-height:1.2}
  .lede{max-width:66ch;margin:0 0 44px}
  .lede b{color:#1B1D1C;font-weight:600}

  .opt{margin:0 0 60px}
  .oh{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;border-bottom:1px solid ${RULE};padding-bottom:12px;margin-bottom:24px}
  .on{font-size:20px;font-weight:600;color:#1B1D1C;letter-spacing:-.015em}
  .oi{color:${GREY};margin-left:auto;font-size:14.5px;max-width:56ch}
  .pair{display:flex;gap:22px;flex-wrap:wrap}
  .screen{flex:1 1 430px;min-width:340px;background:${PAPER};padding:34px 30px 28px}

  .eye{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:${GREY};margin:0 0 4px}
  .head{font-size:19px;font-weight:500;color:${INK};letter-spacing:-.01em;margin:0 0 4px}
  .status{font-size:14px;color:${GREY};margin:0 0 24px}

  .list{position:relative}
  .spine{position:absolute;left:${GUTTER}px;top:0;bottom:0;width:1px;background:${RULE}}
  .row{display:flex;align-items:center}
  .num{width:${GUTTER}px;flex:none;text-align:right;padding-right:18px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .body{flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding-left:18px}
  .track{flex:1;min-width:0;display:block}
  .bar{height:7px;display:block;min-width:1px}
  .lbl{flex:1;min-width:0;font-size:14px}
  .pc{flex:none;width:44px;text-align:right;font-variant-numeric:tabular-nums;font-size:14px}
  .one{margin:0;padding-left:0;font-size:15px;max-width:42ch}

  .foot{display:flex;justify-content:space-between;align-items:baseline;margin-top:26px;padding-left:70px;font-size:15px}
  .go{color:${INK};font-weight:600}
  .cd{color:${GREY}}

  .note{margin:16px 0 0;max-width:70ch;font-size:14.5px}
  .note b{color:#1B1D1C;font-weight:600}
  @media (max-width:760px){.page{padding:36px 18px 70px}.oi{margin-left:0}}
</style></head>
<body><div class="page">
  <p class="eyebrow">Bubblesort · guess distribution</p>
  <h1>Where everyone else landed</h1>
  <p class="lede">The <code>results</code> query already returns this and nothing draws it. Numbers below are invented, but shaped like the solver's real output. Shown on Easy, where you solved in 3.</p>

  ${block(
    "A · Bars",
    "The distribution is a ranked list, so it reuses the board's own gutter and spine. Your row is the only one in ink.",
    bars(EASY)
  )}
  <p class="note"><b>The catch.</b> This introduces the first filled shape anywhere in the product. Arguably fine — a bar is data, not decoration, and width encoding is the honest way to show a quantity. But the design has got this far on type and whitespace alone, and once one bar exists it becomes easy to justify the next one.</p>

  ${block(
    "B · Numbers only",
    "No new shape. The gutter numeral carries the guess count, the percentage sits right-aligned, and your row goes bold.",
    numbers(EASY)
  )}
  <p class="note"><b>The catch.</b> Consistent to a fault. You can read it, but you cannot see it — comparing 34% to 27% takes actual attention, which is exactly the job a bar chart exists to remove.</p>

  ${block(
    "C · One line",
    "Skip the histogram. Say the only thing a player actually wants: am I normal.",
    sentence(EASY),
    false
  )}
  <p class="note"><b>The catch.</b> Smallest and calmest, and it protects the reveal as the payoff instead of burying it under a second data block. But it throws away the comparison entirely, and the shape of a distribution is genuinely interesting on a day where everybody struggled.</p>

  <section class="opt">
    <div class="oh"><span class="on">D · Both</span><span class="oi">The sentence answers "am I normal" at a glance; the bars are there for anyone who wants the shape. Nothing is hidden behind an interaction.</span></div>
    <div class="pair">
      <div class="screen">
        <p class="eye">order by</p>
        <p class="head">stars, most first</p>
        <p class="status">solved in 3</p>
        ${sentence(EASY)}
        <div class="list" style="margin-top:20px"><span class="spine"></span>${bars(EASY)}</div>
        <div class="foot"><span class="go">share</span><span class="cd">next in 06:12:44</span></div>
      </div>
    </div>
  </section>
  <p class="note"><b>The catch.</b> It is the heaviest of the four, and the results screen already has a job: the five real numbers, spaced by magnitude. Stacking a sentence and a chart under that pushes the actual payoff up and away.</p>

  <section class="opt">
    <div class="oh"><span class="on">Day one</span><span class="oi">The case neither mock showed. Right now the database has zero rows, and it will be thin for a while after launch.</span></div>
    <div class="pair">
      <div class="screen">
        <p class="eye">order by</p>
        <p class="head">stars, most first</p>
        <p class="status">solved in 3</p>
        <div class="list"><span class="spine"></span>${bars(TINY)}</div>
        <div class="foot"><span class="go">share</span><span class="cd">next in 06:12:44</span></div>
      </div>
      <div class="screen">
        <p class="eye">order by</p>
        <p class="head">stars, most first</p>
        <p class="status">solved in 3</p>
        ${sentence(TINY)}
        <div class="foot"><span class="go">share</span><span class="cd">next in 06:12:44</span></div>
      </div>
    </div>
  </section>
  <p class="note"><b>This is the whole argument.</b> Three people played. The bars say 33% / 33% / 33%, which is not a distribution, it is noise wearing a chart's clothes, and it will look broken for the first weeks of the game's life. The sentence degrades into something that is arguably nicer at low volume than at high. A chart needs a crowd; a sentence does not.</p>

  <section class="opt">
    <div class="oh"><span class="on">Hard mode, same day</span><span class="oi">Worth seeing, because Hard is where the distribution actually says something: a third of people do not finish.</span></div>
    <div class="pair">
      <div class="screen">
        <p class="eye">order by</p>
        <p class="head">stars, most first</p>
        <p class="status">solved in 2</p>
        <div class="list"><span class="spine"></span>${bars(HARD)}</div>
        <div class="foot"><span class="go">share</span><span class="cd">next in 06:12:44</span></div>
      </div>
      <div class="screen">
        <p class="eye">order by</p>
        <p class="head">stars, most first</p>
        <p class="status">solved in 2</p>
        <div class="list"><span class="spine"></span>${numbers(HARD)}</div>
        <div class="foot"><span class="go">share</span><span class="cd">next in 06:12:44</span></div>
      </div>
    </div>
  </section>
</div></body></html>
`;

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, html);
console.log(`easy total ${total(EASY)}, hard total ${total(HARD)}`);
console.log(`wrote ${path.relative(ROOT, OUT)}`);
