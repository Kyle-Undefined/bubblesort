/**
 * Render the real board in candidate palettes.
 *
 *   node tools/preview-palettes.ts
 *
 * Every neutral is derived, not picked by eye: each role is the lightest blend
 * along its ramp that still clears the contrast its type size requires. That
 * makes the palettes comparable — they differ by hue and paper weight, never by
 * one of them quietly being more readable than another.
 *
 * The current palette fails this. Unlocked repo names sit at 3.32:1 on the warm
 * paper, under the 4.5:1 that 15px text needs, and they are the bulk of the
 * board for most of a game.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CALENDAR } from "../server/data/calendar.gen.ts";
import { REPOS } from "../server/data/repos.gen.ts";
import { statLabel } from "../shared/format.ts";
import { statValue } from "../shared/types.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "design", "palettes.html");
const NOW = Date.now();

// ---------------------------------------------------------------- colour

type RGB = [number, number, number];
const lin = (c: number) => (c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
const lum = ([r, g, b]: RGB) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const toRgb = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const toHex = (c: RGB) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase();
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => v + (b[i] - v) * t) as RGB;
const ratio = (a: RGB, b: RGB) => {
  const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
};

/** Lightest blend of paper toward anchor that still clears `need` against paper. */
function atRatio(paper: RGB, anchor: RGB, need: number): RGB {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const m = (lo + hi) / 2;
    if (ratio(mix(paper, anchor, m), paper) >= need) hi = m;
    else lo = m;
  }
  return mix(paper, anchor, hi);
}

interface Spec {
  name: string;
  idea: string;
  risk: string;
  paper: string;
  ink: string;
  /** What the greys lean toward. Same as ink = monochrome; a neutral = blue stays earned. */
  neutral: string;
}

/**
 * Slate, at five paper weights.
 *
 * The first pass picked the hue and then barely moved the value: every
 * candidate sat between 93% and 97% lightness, which is off-white by any
 * reasonable measure. "Too harsh" is a brightness complaint, and shifting
 * temperature does not answer it. This ladder holds the hue and the rule that
 * blue is earned, and only changes how much light comes off the page.
 */
const SPECS: Spec[] = [
  {
    name: "94% — as shipped",
    idea: "Where Slate landed. Cool rather than warm, but still essentially a white page.",
    risk: "This is the one that did not fix the problem. Included as the baseline to compare against.",
    paper: "#F0F1F3",
    ink: "#24405A",
    neutral: "#2B2F33"
  },
  {
    name: "91% — paper",
    idea: "The first step where the page stops reading as white and starts reading as a light grey surface.",
    risk: "Subtle enough that on a dim screen it may still pass for white.",
    paper: "#E7E9EC",
    ink: "#24405A",
    neutral: "#2B2F33"
  },
  {
    name: "88% — card",
    idea: "Unmistakably a tinted surface. White things placed on it — a dialog, a screenshot — would now read as raised.",
    risk: "Past here the ink has less headroom, so locked rows carry a little less punch.",
    paper: "#DDE0E4",
    ink: "#24405A",
    neutral: "#2A2E32"
  },
  {
    name: "84% — slate",
    idea: "A properly grey page. Glare is gone; the type sits on the surface rather than glowing out of it.",
    risk: "Starts to feel like a utility panel rather than a page. Also the point where a light-grey UI can read as disabled.",
    paper: "#D2D6DB",
    ink: "#223D56",
    neutral: "#26292D"
  },
  {
    name: "79% — stone",
    idea: "The furthest that is still clearly a light theme. Restful for long looking, and the ledger spine gains real presence.",
    risk: "Now a strong claim. It will fight every screenshot pasted on white, and low-quality screens will band the flat fill.",
    paper: "#C4C9CF",
    ink: "#1F384F",
    neutral: "#212427"
  }
];

function build(spec: Spec) {
  const paper = toRgb(spec.paper);
  const ink = toRgb(spec.ink);
  const neutral = toRgb(spec.neutral);
  return {
    ...spec,
    // 15px body — AA needs 4.5:1
    grey: toHex(atRatio(paper, neutral, 4.5)),
    // 11px meta — same floor, small text gets no discount
    muted: toHex(atRatio(paper, neutral, 4.5)),
    // 24-27px numerals count as large text — 3:1
    numeral: toHex(atRatio(paper, neutral, 3.0)),
    rule: toHex(mix(paper, neutral, 0.14)),
    inkRatio: ratio(ink, paper),
    greyRatio: ratio(atRatio(paper, neutral, 4.5), paper),
    numeralRatio: ratio(atRatio(paper, neutral, 3.0), paper)
  };
}

const PALETTES = SPECS.map(build);

// ---------------------------------------------------------------- content

/** A real puzzle, so the comparison is made on real repo names. */
const DAY = CALENDAR.findIndex((d) => d.stat === "stars");
const entry = CALENDAR[DAY];
const answer = entry.answer.map((i) => ({
  slug: REPOS[i].slug,
  value: statValue(REPOS[i], entry.stat)
}));
const shown = entry.shown.map((i) => REPOS[i].slug);
const lockedSlots = new Set([0, 3]);
const armedSlot = 2;

const gaps = (() => {
  const d: number[] = [];
  for (let i = 1; i < answer.length; i++) d.push(Math.abs(answer[i - 1].value - answer[i].value));
  const widest = Math.max(...d, 1);
  return d.map((x) => 10 + Math.round((x / widest) * 46));
})();

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function boardHtml(p: ReturnType<typeof build>) {
  const rows = shown
    .map((slug, slot) => {
      const locked = lockedSlots.has(slot);
      const armed = slot === armedSlot;
      return `
      <div class="row">
        ${locked ? `<span class="lockline" style="background:${p.ink}"></span>` : ""}
        <span class="num" style="color:${locked ? p.ink : p.numeral};font-weight:${locked ? 300 : 200}">${slot + 1}</span>
        <span class="body" style="padding-left:${armed ? 34 : 18}px">
          <span class="slug" style="color:${locked ? p.ink : p.grey};font-weight:${locked ? 700 : 400}">${esc(slug)}</span>
        </span>
      </div>`;
    })
    .join("");

  const res = answer
    .map((r, i) => {
      const gap = i < gaps.length ? `<div style="height:${gaps[i]}px"></div>` : "";
      return `
      <div class="row res">
        <span class="num" style="color:${p.ink};font-weight:300">${i + 1}</span>
        <span class="body" style="padding-left:18px">
          <span class="slug" style="color:${p.ink};font-weight:700">${esc(r.slug)}</span>
          <span class="val" style="color:${p.grey}">${esc(statLabel(entry.stat, r.value, NOW))}</span>
        </span>
      </div>${gap}`;
    })
    .join("");

  return `
  <div class="pair">
    <div class="screen" style="background:${p.paper}">
      <div class="eye" style="color:${p.muted}">order by</div>
      <div class="head" style="color:${p.ink}">stars, most first</div>
      <div class="list"><span class="spine" style="background:${p.rule}"></span>${rows}</div>
      <div class="foot"><span style="color:${p.muted}">3 left</span><span style="color:${p.ink};font-weight:600">submit</span></div>
    </div>
    <div class="screen" style="background:${p.paper}">
      <div class="eye" style="color:${p.muted}">order by</div>
      <div class="head" style="color:${p.ink}">stars, most first</div>
      <div class="status" style="color:${p.muted}">solved in 3</div>
      <div class="list"><span class="spine" style="background:${p.rule}"></span>${res}</div>
      <div class="cap" style="color:${p.muted}">gaps drawn to scale</div>
    </div>
  </div>`;
}

const swatches = (p: ReturnType<typeof build>) =>
  (
    [
      ["paper", p.paper],
      ["ink", p.ink],
      ["grey", p.grey],
      ["numeral", p.numeral],
      ["rule", p.rule]
    ] as const
  )
    .map(
      ([k, v]) =>
        `<span class="sw"><span class="chip" style="background:${v}"></span><span class="lbl">${k}<br><b>${v}</b></span></span>`
    )
    .join("");

const sections = PALETTES.map(
  (p, i) => `
  <section class="pal">
    <div class="ph">
      <span class="pl">${String.fromCharCode(65 + i)}</span>
      <span class="pn">${p.name}</span>
      <span class="pi">${esc(p.idea)}</span>
    </div>
    <div class="sws">${swatches(p)}</div>
    ${boardHtml(p)}
    <p class="pr"><b>Trade-off.</b> ${esc(p.risk)}</p>
    <p class="pm">ink ${p.inkRatio.toFixed(1)}:1 · names ${p.greyRatio.toFixed(1)}:1 · numerals ${p.numeralRatio.toFixed(1)}:1 — all clear WCAG AA for their size</p>
  </section>`
).join("");

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bubblesort — palettes</title>
<style>
  :root{--sans:ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
        --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:#FBFBFA;color:#5A6069;font-family:var(--sans);font-size:15px;line-height:1.55}
  .page{max-width:1180px;margin:0 auto;padding:56px 32px 110px}
  .eyebrow{font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#9BA1A9;margin:0 0 18px}
  h1{font-size:27px;font-weight:600;color:#1B1D1C;letter-spacing:-.02em;margin:0 0 12px;line-height:1.2}
  .lede{max-width:66ch;margin:0 0 20px}
  .lede b{color:#1B1D1C;font-weight:600}
  .warn{border-left:2px solid #B4762A;padding:2px 0 2px 16px;margin:0 0 48px;max-width:66ch;color:#7A6A4F}
  .warn b{color:#6B5A3E}

  .pal{margin:0 0 78px}
  .ph{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;border-bottom:1px solid #E4E5E7;padding-bottom:12px;margin-bottom:22px}
  .pl{font-family:var(--mono);font-size:12px;letter-spacing:.14em;color:#1B1D1C;text-transform:uppercase}
  .pn{font-size:20px;font-weight:600;color:#1B1D1C;letter-spacing:-.015em}
  .pi{color:#5A6069;margin-left:auto;font-size:14.5px;max-width:60ch}

  .sws{display:flex;gap:22px;flex-wrap:wrap;margin-bottom:22px}
  .sw{display:flex;align-items:center;gap:9px}
  .chip{width:30px;height:30px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12);flex:none}
  .lbl{font-family:var(--mono);font-size:10.5px;color:#8A9098;line-height:1.35}
  .lbl b{color:#1B1D1C;font-weight:600}

  .pair{display:flex;gap:22px;flex-wrap:wrap}
  .screen{flex:1 1 400px;min-width:330px;padding:32px 30px 28px;border:1px solid #E4E5E7}
  .eye{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-bottom:4px}
  .head{font-size:19px;font-weight:500;letter-spacing:-.01em;margin-bottom:26px}
  .status{font-size:14px;margin-bottom:22px}
  .list{position:relative}
  .spine{position:absolute;left:52px;top:0;bottom:0;width:1px}
  .row{position:relative;display:flex;align-items:baseline;height:52px}
  .row.res{height:auto}
  .lockline{position:absolute;left:52px;top:0;bottom:0;width:1px}
  .num{width:52px;flex:none;text-align:right;padding-right:18px;font-size:27px;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
  .body{flex:1;min-width:0;display:flex;align-items:baseline;gap:14px}
  .slug{font-family:var(--mono);font-size:15px;letter-spacing:-.02em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .val{margin-left:auto;flex:none;font-variant-numeric:tabular-nums;font-size:15px}
  .foot{display:flex;justify-content:space-between;align-items:baseline;margin-top:24px;padding-left:70px;font-size:15px}
  .cap{font-family:var(--mono);font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-top:20px;padding-left:70px}

  .pr{margin:18px 0 6px;max-width:70ch;font-size:14.5px}
  .pr b{color:#1B1D1C;font-weight:600}
  .pm{margin:0;font-family:var(--mono);font-size:11.5px;color:#9BA1A9}

  @media (max-width:760px){.page{padding:36px 18px 70px}.pi{margin-left:0}}
</style></head>
<body><div class="page">
  <p class="eyebrow">Bubblesort · paper weight</p>
  <h1>How much light should come off the page?</h1>
  <p class="lede">Slate's hue, held constant, at five values. Everything else is unchanged: the ledger frame, the mono slugs, and blue reserved entirely for locked rows.</p>
  <div class="warn"><b>Correcting the last pass.</b> All four palettes I showed sat between <b>93% and 97% lightness</b> — off-white, every one of them. They differed in temperature, and "too harsh" is a complaint about brightness, so none of them actually answered it. This ladder changes only the value. Each step re-derives its own neutrals, so contrast stays correct as the paper darkens rather than quietly degrading.</div>
  ${sections}
</div></body></html>
`;

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, html);

console.log(`puzzle used: #${DAY + 1} (${entry.stat})`);
for (const p of PALETTES) {
  console.log(
    `${p.name.padEnd(10)} paper ${p.paper}  ink ${p.ink}  grey ${p.grey}  numeral ${p.numeral}  rule ${p.rule}`
  );
}
console.log(`\nwrote ${path.relative(ROOT, OUT)}`);
