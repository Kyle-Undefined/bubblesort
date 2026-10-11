import { canAccessApp, ErrorBoundary, Link, retryAuth, Route, Router, Routes, useAuth, useMutation, useParams, useQuery } from "lakebed/client";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { calendarDate, msUntilNextDay, statLabel } from "../shared/format.ts";
import { SLOTS } from "../shared/puzzle.ts";
import { SITE, shareText } from "../shared/share.ts";
import type { Mode, StatKey } from "../shared/types.ts";

// ---------------------------------------------------------------- design
//
// The whole visual system, in one place. One typeface, one size, two weights,
// four colours. Hierarchy comes from weight and position — nothing here has a
// background, a border, a shadow or a corner radius.
//
// The hue does exactly one job: a locked row takes it. The board opens entirely
// grey and colour arrives only as it is earned, so at most five coloured lines
// ever exist and only on a solved board.

// Slate: a cool neutral paper with blue reserved entirely for locked rows, so
// the hue stays earned and nothing else on the page is ever coloured.
//
// Every value is derived rather than chosen by eye — each is the lightest blend
// on the paper-to-anchor ramp that still clears the contrast its type size
// needs. The palette this replaced was warm and, more importantly, failed:
// unlocked repo names sat at 3.32:1 against 15px text's 4.5:1 floor, and rank
// numerals at 1.89:1 against 3:1 for large text.
//
// The paper value matters as much as its hue. A first pass at this landed on
// 94% lightness, four points off the 98% it replaced, and still read as a white
// page — the complaint was about glare, and only the temperature had moved.
// 91% is where the page stops being off-white and becomes a surface.
const PAPER = "#E7E9EC"; // 91% — a light grey surface, not an off-white one
const INK = "#24405A"; // locked — 8.8:1
const GREY = "#666A6D"; // unlocked names and all small text — 4.5:1
const NUMERAL = "#83868A"; // rank digits only, 24px+ counts as large text — 3:1
const RULE = "#CDCFD2"; // the spine

// GREY covers 11px meta as well as 15px body on purpose. The token it replaced
// set both 27px numerals and 11px labels, which have different thresholds — so
// one of the two was always going to be under-contrast.

/**
 * Two system faces, each with one job.
 *
 * Mono is for repo slugs only. `owner/name` is a path, so setting it in a
 * monospace is honest rather than decorative — and it gives the page a real
 * pairing instead of a single face doing every job. Everything else is sans.
 */
const SANS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace';

const ROW_H = 52;
const GUTTER = 52; // rank column width — the spine sits at its right edge
const SWAP_MS = 380;

/** Eyebrow: small, letterspaced, uppercase. Used for labels that are not content. */
const eyebrow = {
  fontFamily: MONO,
  fontSize: "11px",
  letterSpacing: "0.14em",
  textTransform: "uppercase" as const,
  color: GREY
};

// ---------------------------------------------------------------- storage

const KEY_CLIENT = "bubblesort.clientKey";
const keyStreak = (mode: Mode) => `bubblesort.streak.${mode}`;

function readClientKey(): string {
  try {
    const existing = localStorage.getItem(KEY_CLIENT);
    if (existing) return existing;
    const made = crypto.randomUUID();
    localStorage.setItem(KEY_CLIENT, made);
    return made;
  } catch {
    // Private mode with storage disabled: the game still plays, it just cannot
    // remember anything between reloads.
    return crypto.randomUUID();
  }
}

interface Streak {
  current: number;
  best: number;
  lastDay: number;
  played: number;
  wins: number;
}

const EMPTY_STREAK: Streak = { current: 0, best: 0, lastDay: -1, played: 0, wins: 0 };

function readStreak(mode: Mode): Streak {
  try {
    const raw = localStorage.getItem(keyStreak(mode));
    return raw ? { ...EMPTY_STREAK, ...JSON.parse(raw) } : EMPTY_STREAK;
  } catch {
    return EMPTY_STREAK;
  }
}

function recordResult(mode: Mode, day: number, solved: boolean): Streak {
  const prev = readStreak(mode);
  if (prev.lastDay === day) return prev; // already counted

  const next: Streak = {
    // A streak survives only if the previous win was yesterday.
    current: solved ? (prev.lastDay === day - 1 ? prev.current : 0) + 1 : 0,
    best: prev.best,
    lastDay: day,
    played: prev.played + 1,
    wins: prev.wins + (solved ? 1 : 0)
  };
  next.best = Math.max(prev.best, next.current);

  try {
    localStorage.setItem(keyStreak(mode), JSON.stringify(next));
  } catch {
    /* storage disabled; the number just will not persist */
  }
  return next;
}

// ---------------------------------------------------------------- helpers

const identity = () => Array.from({ length: SLOTS }, (_, i) => i);

/** Slots locked by any previous guess, mapped to the item that locked them. */
function lockedSlots(guesses: number[][], marks: boolean[][]): Map<number, number> {
  const locked = new Map<number, number>();
  for (let g = 0; g < marks.length; g++) {
    for (let s = 0; s < SLOTS; s++) if (marks[g]?.[s]) locked.set(s, guesses[g][s]);
  }
  return locked;
}

/**
 * Below this many players, percentages are theatre — 33% of three people is one
 * person, and that person is you. Counting is both more honest and better copy.
 */
const CROWD = 20;

/** The one line that answers the only question a player actually has: am I normal. */
function crowdLine(
  total: number,
  yours: number,
  mine: string,
  best: string,
  isArchive: boolean
): string {
  if (total < CROWD) {
    if (total <= 1) return isArchive ? "First to finish this puzzle." : "First to finish today.";
    return isArchive
      ? `You are one of ${total} who played this puzzle.`
      : `You are one of ${total} who have played today.`;
  }

  const share = Math.round((yours / total) * 100);
  const mineText = mine === "X" ? `${share}% also did not finish` : `${share}% also solved it in ${mine}`;
  const period = isArchive ? "that day" : "today";
  const tail =
    best === mine
      ? `, the most common ${mine === "X" ? "result" : "score"} ${period}`
      : `. Most people ${best === "X" ? "did not finish" : `solved it in ${best}`}`;
  return `${mineText}${tail}. ${total.toLocaleString("en-US")} played.`;
}

function countdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** The page frame. Every screen sits in the same measure. */
function Shell({ children }: { children: preact.ComponentChildren }) {
  return (
    <main
      style={{
        minHeight: "100vh",
        background: PAPER,
        color: GREY,
        fontFamily: SANS,
        fontSize: "15px",
        lineHeight: 1.2,
        padding: "56px 24px 72px"
      }}
    >
      <div style={{ maxWidth: "470px", margin: "0 auto" }}>{children}</div>
    </main>
  );
}

// ---------------------------------------------------------------- board

interface BoardProps {
  items: { slug: string }[];
  order: number[];
  locked: Map<number, number>;
  armed: number | null;
  onPick: (slot: number) => void;
  onSwap: (from: number, to: number) => void;
  disabled: boolean;
}

interface DragState {
  pointerId: number;
  source: number;
  target: number | null;
  startY: number;
  deltaY: number;
  active: boolean;
}

function Board({ items, order, locked, armed, onPick, onSwap, disabled }: BoardProps) {
  const board = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<number, HTMLButtonElement>());
  const prevRects = useRef(new Map<number, DOMRect>());
  const dropOffsets = useRef(new Map<number, number>());
  const ignoreClick = useRef(false);
  const [drag, setDrag] = useState<DragState | null>(null);

  /**
   * FLIP. Measure where every row was, let the reorder render, then animate each
   * moved row from its old position back to zero along a curve so the two rows
   * travel *around* each other instead of sliding through.
   *
   * This is the only motion in the product, which is exactly why it is worth
   * hand-rolling rather than settling for a crossfade.
   */
  useLayoutEffect(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;

    for (const [item, el] of nodes.current) {
      const now = el.getBoundingClientRect();
      const was = prevRects.current.get(item);
      const dropOffset = dropOffsets.current.get(item) ?? 0;
      prevRects.current.set(item, now);
      dropOffsets.current.delete(item);
      if (!was || reduce) continue;

      const dy = was.top - now.top;
      const startY = dy + dropOffset;
      if (Math.abs(startY) < 1) continue;

      // Bow outward, in opposite directions for the two travelling rows, so
      // their paths never overlap.
      const bow = dy > 0 ? 14 : -14;
      el.animate(
        [
          { transform: `translate(0px, ${startY}px)` },
          { transform: `translate(${bow}px, ${startY * 0.5}px)` },
          { transform: "translate(0px, 0px)" }
        ],
        { duration: SWAP_MS, easing: "cubic-bezier(.4, 0, .2, 1)" }
      );
    }
  }, [order]);

  return (
    <div ref={board} role="list" style={{ position: "relative" }}>
      {/*
        The spine, drawn once for the whole board rather than per row.
        Bordering each row individually leaves a gap wherever a row's content is
        shorter than its box, which turns a continuous rule into a column of
        dashes. Locked rows paint their own ink segment over this.
      */}
      <span
        aria-hidden="true"
        style={{ position: "absolute", left: `${GUTTER}px`, top: 0, bottom: 0, borderLeft: `1px solid ${RULE}` }}
      />
      {order.map((item, slot) => {
        const isLocked = locked.get(slot) === item;
        const isArmed = armed === slot;
        const isDragged = drag?.active && drag.source === slot;
        const isDropTarget =
          drag?.active && drag.target === slot && drag.source !== slot && !isLocked;
        return (
          <button
            key={item}
            ref={(el) => {
              if (el) nodes.current.set(item, el);
              else nodes.current.delete(item);
            }}
            type="button"
            role="listitem"
            disabled={disabled || isLocked}
            aria-label={`Slot ${slot + 1}, ${items[item].slug}${isLocked ? ", locked" : ""}`}
            aria-pressed={isArmed}
            onClick={() => {
              if (ignoreClick.current) return;
              onPick(slot);
            }}
            onPointerDown={(event) => {
              if (disabled || isLocked || event.button !== 0) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag({
                pointerId: event.pointerId,
                source: slot,
                target: slot,
                startY: event.clientY,
                deltaY: 0,
                active: false
              });
            }}
            onPointerMove={(event) => {
              if (!drag || drag.pointerId !== event.pointerId) return;
              const deltaY = event.clientY - drag.startY;
              const active = drag.active || Math.abs(deltaY) >= 6;
              let target: number | null = drag.source;
              if (active) {
                const rect = board.current?.getBoundingClientRect();
                target = rect && event.clientY >= rect.top && event.clientY < rect.bottom
                  ? Math.floor((event.clientY - rect.top) / ROW_H)
                  : null;
              }
              setDrag({ ...drag, deltaY, active, target });
            }}
            onPointerUp={(event) => {
              if (!drag || drag.pointerId !== event.pointerId) return;
              if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              if (drag.active) {
                // A pointer drag still emits a click after pointerup. Consume
                // only that compatibility click so it cannot arm the moved row.
                ignoreClick.current = true;
                setTimeout(() => {
                  ignoreClick.current = false;
                }, 0);
                if (drag.target !== null && drag.target !== drag.source) {
                  const targetItem = order[drag.target];
                  if (locked.get(drag.target) !== targetItem) {
                    // Preserve the dragged row's on-screen drop point through
                    // the reorder. Its partner still takes the existing curved
                    // FLIP path into the vacated slot.
                    dropOffsets.current.set(item, drag.deltaY);
                    onSwap(drag.source, drag.target);
                  }
                }
              }
              setDrag(null);
            }}
            onPointerCancel={() => setDrag(null)}
            style={{
              position: "relative",
              display: "flex",
              width: "100%",
              alignItems: "baseline",
              textAlign: "left",
              height: `${ROW_H}px`,
              background: "none",
              border: "none",
              font: "inherit",
              padding: 0,
              cursor: disabled || isLocked ? "default" : isDragged ? "grabbing" : "grab",
              touchAction: disabled || isLocked ? "auto" : "none",
              userSelect: "none",
              zIndex: isDragged ? 1 : undefined,
              transform: isDragged ? `translateY(${drag.deltaY}px)` : undefined
            }}
          >
            {isLocked ? (
              <span
                aria-hidden="true"
                style={{
                  position: "absolute",
                  left: `${GUTTER}px`,
                  top: 0,
                  bottom: 0,
                  borderLeft: `1px solid ${INK}`
                }}
              />
            ) : null}

            {/* Rank. The largest thing on the board — this is a ranking game, so
                the numerals are the subject, not a bullet. */}
            <span
              style={{
                width: `${GUTTER}px`,
                flex: "none",
                textAlign: "right",
                paddingRight: "18px",
                fontSize: "27px",
                fontWeight: isLocked ? 300 : 200,
                letterSpacing: "-0.02em",
                color: isLocked ? INK : NUMERAL,
                fontVariantNumeric: "tabular-nums lining-nums"
              }}
            >
              {slot + 1}
            </span>

            <span
              style={{
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "baseline",
                gap: "14px",
                paddingLeft: isArmed || isDropTarget ? "34px" : "18px",
                transition: "padding-left 140ms ease"
              }}
            >
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: "15px",
                  letterSpacing: "-0.02em",
                  color: isLocked ? INK : GREY,
                  fontWeight: isLocked ? 700 : 400,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap"
                }}
              >
                {items[item].slug}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- results

interface DistributionData {
  total: number;
  buckets: Record<string, number>;
}

function isDistributionData(value: unknown): value is DistributionData {
  return (
    Boolean(value) &&
    !Array.isArray(value) &&
    typeof (value as DistributionData).total === "number" &&
    Boolean((value as DistributionData).buckets)
  );
}

/** C by default; A is available on demand without competing with the reveal. */
function Distribution({
  day,
  mode,
  solved,
  guesses,
  isArchive
}: {
  day: number;
  mode: Mode;
  solved: boolean;
  guesses: number;
  isArchive: boolean;
}) {
  const raw = useQuery<unknown>("results", { day, mode });
  const [expanded, setExpanded] = useState(false);

  // Only render the distribution after a complete response arrives.
  if (!isDistributionData(raw) || raw.total < 1) return null;

  const keys = [...Array.from({ length: mode === "easy" ? 5 : 3 }, (_, i) => String(i + 1)), "X"];
  const mine = solved ? String(guesses) : "X";
  const yours = raw.buckets[mine] ?? 0;
  const best = keys.reduce((a, b) => ((raw.buckets[b] ?? 0) > (raw.buckets[a] ?? 0) ? b : a));
  const peak = Math.max(...keys.map((key) => raw.buckets[key] ?? 0), 1);
  const panelId = `distribution-${day}-${mode}`;

  return (
    <section style={{ margin: "0 0 26px" }} aria-label="Global guess distribution">
      <p style={{ color: GREY, margin: 0, lineHeight: 1.5 }}>
        {crowdLine(raw.total, yours, mine, best, isArchive)}{" "}
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((open) => !open)}
          style={{
            color: INK,
            background: "none",
            border: "none",
            font: "inherit",
            padding: 0,
            cursor: "pointer",
            textDecoration: "underline",
            textUnderlineOffset: "3px"
          }}
        >
          stats
        </button>
      </p>

      {expanded ? (
        <div
          id={panelId}
          role="list"
          style={{ position: "relative", marginTop: "18px" }}
        >
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: `${GUTTER}px`,
              top: 0,
              bottom: 0,
              borderLeft: `1px solid ${RULE}`
            }}
          />
          {keys.map((key) => {
            const count = raw.buckets[key] ?? 0;
            const percent = Math.round((count / raw.total) * 100);
            const mineRow = key === mine;
            const width = Math.round((count / peak) * 100);
            const label = key === "X" ? "Did not finish" : `${key} guess${key === "1" ? "" : "es"}`;

            return (
              <div
                key={key}
                role="listitem"
                aria-label={`${label}: ${percent}%`}
                style={{ height: "36px", display: "flex", alignItems: "center" }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: `${GUTTER}px`,
                    flex: "none",
                    textAlign: "right",
                    paddingRight: "18px",
                    fontSize: "19px",
                    fontWeight: mineRow ? 400 : 300,
                    letterSpacing: "-0.02em",
                    color: mineRow ? INK : NUMERAL,
                    fontVariantNumeric: "tabular-nums lining-nums"
                  }}
                >
                  {key}
                </span>
                <span
                  aria-hidden="true"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    paddingLeft: "18px"
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span
                      style={{
                        display: "block",
                        width: `${width}%`,
                        minWidth: count > 0 ? "1px" : 0,
                        height: "7px",
                        background: mineRow ? INK : RULE
                      }}
                    />
                  </span>
                  <span
                    style={{
                      width: "44px",
                      flex: "none",
                      textAlign: "right",
                      color: mineRow ? INK : GREY,
                      fontWeight: mineRow ? 700 : 400,
                      fontVariantNumeric: "tabular-nums lining-nums"
                    }}
                  >
                    {percent}%
                  </span>
                </span>
              </div>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}

function Results({
  day,
  mode,
  marks,
  solved,
  budget,
  reveal,
  stat,
  streak,
  isArchive
}: {
  day: number;
  mode: Mode;
  marks: boolean[][];
  solved: boolean;
  budget: number;
  reveal: { slug: string; value: number }[];
  stat: StatKey;
  streak: Streak;
  isArchive: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [left, setLeft] = useState(() => msUntilNextDay(Date.now()));
  const now = Date.now();

  /**
   * Vertical space between each adjacent pair, proportional to the real
   * difference between their values.
   *
   * Absolute difference, because `age` is handed back as a raw timestamp that
   * ascends down the board (oldest first) while every other stat descends.
   */
  const gaps = useMemo(() => {
    const diffs: number[] = [];
    for (let i = 1; i < reveal.length; i++) diffs.push(Math.abs(reveal[i - 1].value - reveal[i].value));
    const widest = Math.max(...diffs, 1);
    return diffs.map((d) => 10 + Math.round((d / widest) * 46));
  }, [reveal]);

  useEffect(() => {
    const t = setInterval(() => setLeft(msUntilNextDay(Date.now())), 1000);
    return () => clearInterval(t);
  }, []);

  const text = shareText({ day, mode, stat, guesses: marks.length, solved, budget });

  const share = async () => {
    try {
      if (navigator.share) {
        await navigator.share({ text });
        return;
      }
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard blocked (insecure context, or permission denied). Fall back to
      // the oldest trick that still works everywhere.
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      } catch {
        /* nothing left to try */
      }
      document.body.removeChild(ta);
    }
  };

  return (
    <div>
      <p style={{ color: GREY, marginBottom: "28px" }} aria-live="polite">
        {solved ? `solved in ${marks.length}` : "out of guesses"}
        {streak.current > 1 ? ` · ${streak.current} day streak` : ""}
      </p>

      {/*
        The reveal spaces itself by magnitude: the gap between two rows is
        proportional to the real distance between their values, so the answer
        resolves into a chart made of nothing but whitespace — no bars, no axes,
        no elements that did not already exist.

        Deliberately the LINEAR difference, not the ratio. Puzzles are generated
        as a chain where each step is at least 1.35x, and the generator picks
        similar ratios, so across 200 real puzzles the ratio gaps varied only
        1.8x — spacing by ratio would have come out flat. Linear differences
        vary 11.7x, which is what makes the shape worth drawing.
      */}
      <div role="list" style={{ position: "relative", marginBottom: "26px" }}>
        <span
          aria-hidden="true"
          style={{ position: "absolute", left: `${GUTTER}px`, top: 0, bottom: 0, borderLeft: `1px solid ${RULE}` }}
        />
        {reveal.map((r, i) => (
          <div key={r.slug}>
            <div role="listitem" style={{ display: "flex", alignItems: "baseline" }}>
              <span
                style={{
                  width: `${GUTTER}px`,
                  flex: "none",
                  textAlign: "right",
                  paddingRight: "18px",
                  fontSize: "27px",
                  fontWeight: 300,
                  letterSpacing: "-0.02em",
                  color: INK,
                  fontVariantNumeric: "tabular-nums lining-nums"
                }}
              >
                {i + 1}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: "flex",
                  alignItems: "baseline",
                  gap: "14px",
                  paddingLeft: "18px"
                }}
              >
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: "15px",
                    letterSpacing: "-0.02em",
                    color: INK,
                    fontWeight: 700,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  }}
                >
                  {r.slug}
                </span>
                <span
                  style={{
                    marginLeft: "auto",
                    flex: "none",
                    color: GREY,
                    fontVariantNumeric: "tabular-nums lining-nums"
                  }}
                >
                  {statLabel(stat, r.value, now)}
                </span>
              </span>
            </div>

            {/* The interval. Empty space — the spine behind the list runs through it. */}
            {i < gaps.length ? <div aria-hidden="true" style={{ height: `${gaps[i]}px` }} /> : null}
          </div>
        ))}
      </div>

      <p style={{ ...eyebrow, margin: "0 0 26px", paddingLeft: `${GUTTER + 18}px` }}>gaps drawn to scale</p>

      <Distribution
        day={day}
        mode={mode}
        solved={solved}
        guesses={marks.length}
        isArchive={isArchive}
      />

      {/*
        The guess grid deliberately does not appear here or in the copied share
        text.
        Wordle can show that grid because Wordle's board *is* a grid of squares.
        This board is a list, and lock state is carried by weight — a row going
        bold. Putting squares on the results screen introduces a notation the
        player has never once encountered while playing, to re-state something
        they already read a different way. The share text names the task and
        score in plain language instead.
      */}
      <div style={{ display: "flex", alignItems: "center", gap: "24px" }}>
        <button
          type="button"
          onClick={() => void share()}
          style={{
            color: INK,
            fontWeight: 700,
            background: "none",
            border: "none",
            font: "inherit",
            padding: 0,
            cursor: "pointer"
          }}
        >
          {copied ? "copied" : "share"}
        </button>
        <span style={{ color: GREY, fontVariantNumeric: "tabular-nums" }}>next in {countdown(left)}</span>
      </div>

      {streak.played > 1 ? (
        <p style={{ color: GREY, marginTop: "26px" }}>
          {streak.played} played · {Math.round((streak.wins / streak.played) * 100)}% won · best streak {streak.best}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- app

/**
 * Routes carry the puzzle NUMBER (1-based, "#142"), not the internal day index.
 * That is the number on the share string, so a URL someone pastes and a score
 * someone posts refer to the same thing.
 */
function Game({ requestedDay }: { requestedDay?: number }) {
  const [clientKey] = useState(readClientKey);
  const today = useQuery<any>("today", { clientKey, day: requestedDay });
  const submit =
    useMutation<[args: { clientKey: string; mode: string; order: number[]; day: number }], any>("submit");

  const [mode, setMode] = useState<Mode>("easy");
  const [order, setOrder] = useState<number[]>(identity);
  const [armed, setArmed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState("");
  const [streak, setStreak] = useState<Streak>(() => readStreak("easy"));

  const ready = today && today.ready;
  const isArchive: boolean = ready ? Boolean(today.isArchive) : false;
  const session = ready ? today.sessions?.[mode] : null;
  const guesses: number[][] = session?.guesses ?? [];
  const marks: boolean[][] = session?.marks ?? [];
  const finished: boolean = session?.finished ?? false;
  const budget: number = ready ? today.budget[mode] : 0;
  const locked = lockedSlots(guesses, marks);

  /**
   * Mode locks on the first submit. If a session already exists for one mode,
   * that is the mode being played today — otherwise a player could burn every
   * Hard guess and flip to Easy for more.
   */
  const committed: Mode | null = ready
    ? (["easy", "hard"] as Mode[]).find((m) => today.sessions?.[m]) ?? null
    : null;

  useEffect(() => {
    if (committed && committed !== mode) setMode(committed);
  }, [committed]);

  useEffect(() => setStreak(readStreak(mode)), [mode]);

  // Restore the board from the last submitted guess, so a refresh mid-game
  // loses nothing.
  useEffect(() => {
    if (!ready) return;
    setOrder(guesses.length ? guesses[guesses.length - 1].slice() : identity());
    setArmed(null);
  }, [ready, mode, guesses.length]);

  /**
   * Record the result exactly once, when a game transitions to finished — and
   * never for an archive day.
   *
   * A streak is a claim about showing up daily. If back-filling last Tuesday
   * could repair a gap, the number would only measure how much free time
   * someone had, so archive games are deliberately invisible to streaks and to
   * the win rate.
   */
  const recorded = useRef<string>("");
  useEffect(() => {
    if (!ready || !finished || isArchive) return;
    const tag = `${today.day}:${mode}`;
    if (recorded.current === tag) return;
    recorded.current = tag;
    setStreak(recordResult(mode, today.day, Boolean(session?.solved)));
  }, [ready, finished, mode, isArchive]);

  const swap = useCallback(
    (from: number, to: number) => {
      if (finished || busy || from === to) return;
      setOrder((prev) => {
        if (locked.get(from) === prev[from] || locked.get(to) === prev[to]) return prev;
        const next = prev.slice();
        [next[from], next[to]] = [next[to], next[from]];
        return next;
      });
      setArmed(null);
    },
    [finished, busy, locked]
  );

  const pick = useCallback(
    (slot: number) => {
      if (finished || busy) return;
      if (locked.get(slot) === order[slot]) return;
      if (armed === null) {
        setArmed(slot);
        return;
      }
      if (armed === slot) {
        setArmed(null);
        return;
      }
      swap(armed, slot);
    },
    [armed, finished, busy, locked, order, swap]
  );

  const onSubmit = useCallback(async () => {
    if (finished || busy || !ready) return;
    setBusy(true);
    try {
      const res = await submit({ clientKey, mode, order, day: today.day });
      if (res?.ok) {
        const last: boolean[] = res.marks[res.marks.length - 1];
        const n = last.filter(Boolean).length;
        setLive(n === 0 ? "no slots correct" : `${n} slot${n === 1 ? "" : "s"} locked`);
      } else if (res?.error) {
        setLive(res.error);
      }
    } finally {
      setBusy(false);
    }
  }, [clientKey, mode, order, finished, busy, ready, submit]);

  // Keyboard: 1-5 arms a slot, arrows move the armed row, Enter submits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (finished) return;
      if (e.key >= "1" && e.key <= String(SLOTS)) {
        pick(Number(e.key) - 1);
        e.preventDefault();
      } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && armed !== null) {
        const target = armed + (e.key === "ArrowDown" ? 1 : -1);
        if (target >= 0 && target < SLOTS) {
          const keep = armed;
          pick(target);
          setArmed(target === keep ? null : target);
        }
        e.preventDefault();
      } else if (e.key === "Enter") {
        void onSubmit();
        e.preventDefault();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [pick, onSubmit, armed, finished]);

  const shell = (children: preact.ComponentChildren) => <Shell>{children}</Shell>;

  if (!today) {
    // Keep the board's height while making connection progress visible.
    return shell(<div role="status" style={{ minHeight: `${ROW_H * SLOTS + 160}px` }}>Loading puzzle...</div>);
  }
  if (!ready) {
    return shell(
      <p style={{ color: GREY }}>
        No puzzle is available for this date.
      </p>
    );
  }

  const used = guesses.length;

  return shell(
    <>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "20px",
          marginBottom: "30px"
        }}
      >
        <span>
          <span style={{ ...eyebrow, display: "block", marginBottom: "4px" }}>order by</span>
          <span style={{ fontSize: "19px", fontWeight: 500, color: "#1B1D1C", letterSpacing: "-0.01em" }}>
            {today.phrase ?? today.prompt}
          </span>
        </span>
        {committed ? (
          <span style={{ color: GREY }}>{mode}</span>
        ) : (
          <button
            type="button"
            onClick={() => setMode(mode === "easy" ? "hard" : "easy")}
            style={{
              color: GREY,
              background: "none",
              border: "none",
              font: "inherit",
              padding: 0,
              cursor: "pointer",
              textDecoration: "underline",
              textUnderlineOffset: "3px"
            }}
          >
            {mode}
          </button>
        )}
      </div>

      {finished ? (
        <Results
          day={today.day}
          mode={mode}
          marks={marks}
          solved={Boolean(session?.solved)}
          budget={budget}
          reveal={session?.reveal ?? []}
          stat={today.stat}
          streak={streak}
          isArchive={isArchive}
        />
      ) : (
        <>
          <Board
            items={today.items}
            order={order}
            locked={locked}
            armed={armed}
            onPick={pick}
            onSwap={swap}
            disabled={busy}
          />

          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              justifyContent: "space-between",
              gap: "20px",
              marginTop: "26px",
              paddingLeft: `${GUTTER + 18}px`
            }}
          >
            <span style={{ color: GREY, fontVariantNumeric: "tabular-nums" }}>
              {budget - used} left
            </span>
            <button
              type="button"
              onClick={() => void onSubmit()}
              disabled={busy}
              style={{
                color: INK,
                fontWeight: 700,
                background: "none",
                border: "none",
                font: "inherit",
                padding: 0,
                cursor: busy ? "default" : "pointer"
              }}
            >
              submit
            </button>
          </div>

          <p aria-live="polite" style={{ position: "absolute", left: "-9999px" }}>
            {live}
          </p>
        </>
      )}

      {/*
        The label stays anchored left and the arrows stay anchored right, so the
        footer does not shuffle sideways as puzzles gain or lose a neighbour —
        #1 has no previous and today has no next.
      */}
      <nav
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "20px",
          marginTop: "48px",
          fontSize: "13px",
          color: GREY
        }}
      >
        {/*
          Says "no streak", not "archive". The right-hand side already carries a
          link labelled archive, and using the same word for a state and a
          destination in one footer makes both harder to read. The "today" link
          is what tells you this is a past puzzle.
        */}
        <span>
          {SITE} · #{today.day + 1}
          {isArchive ? " · no streak" : ""}
        </span>

        {/*
          One way in and out, not two. Stepping through puzzles with prev/next
          arrows was a stopgap before the index existed; keeping both meant the
          footer carried three links and a stray "#1" that read as noise.
        */}
        <span style={{ display: "flex", gap: "16px", flex: "none" }}>
          {isArchive ? (
            <Link to="/" style={{ color: GREY, textDecoration: "none" }}>
              today
            </Link>
          ) : null}
          <Link to="/archive" style={{ color: GREY, textDecoration: "none" }}>
            archive
          </Link>
        </span>
      </nav>
    </>
  );
}

/**
 * The archive, paged by calendar month.
 *
 * A month is a page a player can hold in their head; "puzzles 21 to 35" is not.
 * It also means the page names itself and the header needs no explaining.
 */
function Archive() {
  const [clientKey] = useState(readClientKey);
  const { month } = useParams<{ month?: string }>();
  const data = useQuery<any>("archive", { clientKey, month });

  if (!data?.days) return <Shell><p role="status">Loading archive...</p></Shell>;

  const pct = data.totals.played ? Math.round((data.totals.solved / data.totals.played) * 100) : 0;

  return (
    <Shell>
      <div style={{ marginBottom: "30px" }}>
        <span style={{ ...eyebrow, display: "block", marginBottom: "4px" }}>archive</span>
        <span style={{ fontSize: "19px", fontWeight: 500, color: "#1B1D1C", letterSpacing: "-0.01em" }}>
          {data.label}
        </span>
      </div>

      <div style={{ position: "relative" }}>
        <span
          aria-hidden="true"
          style={{ position: "absolute", left: `${GUTTER}px`, top: 0, bottom: 0, borderLeft: `1px solid ${RULE}` }}
        />
        {data.days.length === 0 ? (
          <p style={{ paddingLeft: `${GUTTER + 18}px`, color: GREY }}>No puzzles this month.</p>
        ) : (
          data.days.map((d: any) => (
            <Link
              key={d.day}
              to={d.day === data.current ? "/" : `/${d.day + 1}`}
              style={{ display: "flex", alignItems: "baseline", minHeight: "54px", textDecoration: "none" }}
            >
              <span
                style={{
                  width: `${GUTTER}px`,
                  flex: "none",
                  textAlign: "right",
                  paddingRight: "18px",
                  fontSize: "24px",
                  fontWeight: d.day === data.current ? 300 : 200,
                  letterSpacing: "-0.02em",
                  color: d.day === data.current ? INK : NUMERAL,
                  fontVariantNumeric: "tabular-nums lining-nums"
                }}
              >
                {calendarDate(d.day).dom}
              </span>
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  paddingLeft: "18px",
                  paddingBottom: "14px",
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "0 12px"
                }}
              >
                <span
                  style={{
                    gridColumn: 1,
                    fontSize: "15px",
                    color: d.played ? INK : GREY,
                    fontWeight: d.played ? 600 : 400,
                    letterSpacing: "-0.01em"
                  }}
                >
                  {d.stat === "openIssues" ? "open issues" : d.stat}
                </span>
                <span style={{ gridColumn: 2, gridRow: 1, justifySelf: "end" }}>
                  {!d.played ? (
                    <span style={{ ...eyebrow, color: INK }}>play</span>
                  ) : !d.finished ? (
                    <span style={{ ...eyebrow, color: INK }}>resume</span>
                  ) : d.solved ? (
                    <span style={{ color: INK, fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                      {d.guesses}/{d.budget}
                    </span>
                  ) : (
                    <span style={{ color: GREY }}>missed</span>
                  )}
                </span>
                {/*
                  Weekday always; the day's top repo only once that day is over
                  — see the archive query, which withholds it otherwise.
                */}
                <span
                  style={{
                    gridColumn: 1,
                    gridRow: 2,
                    fontFamily: MONO,
                    fontSize: "11px",
                    color: GREY,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  }}
                >
                  {calendarDate(d.day).dow}
                  {d.top ? ` · ${d.top}` : ""}
                </span>
              </span>
            </Link>
          ))
        )}
      </div>

      <nav
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "20px",
          marginTop: "28px",
          paddingLeft: `${GUTTER + 18}px`,
          fontSize: "13px",
          color: GREY
        }}
      >
        <span>
          {data.prev ? (
            <Link to={`/archive/${data.prev}`} style={{ color: GREY, textDecoration: "none" }}>
              ‹ earlier
            </Link>
          ) : null}
        </span>
        <span>
          {data.next ? (
            <Link to={`/archive/${data.next}`} style={{ color: GREY, textDecoration: "none" }}>
              later ›
            </Link>
          ) : null}
        </span>
      </nav>

      <nav
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "20px",
          marginTop: "48px",
          fontSize: "13px",
          color: GREY
        }}
      >
        <span>
          {SITE}
          {data.totals.played ? ` · ${data.totals.played} played · ${pct}% solved` : ""}
        </span>
        <Link to="/" style={{ color: GREY, textDecoration: "none" }}>
          today ›
        </Link>
      </nav>
    </Shell>
  );
}

export function App() {
  const auth = useAuth();

  // Hosted Lakebed requires a protected guest session before app queries.
  // Keep game hooks unmounted until that session is ready, and expose retries
  // when session setup fails instead of leaving the loading screen empty.
  if (auth.isLoading) return <Shell><p role="status">Connecting to the game...</p></Shell>;
  if (!canAccessApp()) {
    return (
      <Shell>
        <p role="alert">{auth.error ?? "Could not connect to the game."}</p>
        <RetryButton onRetry={() => void retryAuth()} />
      </Shell>
    );
  }

  return (
    <ErrorBoundary fallback={(error, retry) => (
      <Shell>
        <p role="alert">Could not load the game. {error.message}</p>
        <RetryButton onRetry={() => void retryAuth().then(retry)} />
      </Shell>
    )}>
      <Router>
        <Routes>
          <Route path="/" element={<Game />} />
          <Route path="/archive" element={<Archive />} />
          <Route path="/archive/:month" element={<Archive />} />
          <Route path="/:puzzle" element={<ArchiveGame />} />
          <Route path="*" element={<Game />} />
        </Routes>
      </Router>
    </ErrorBoundary>
  );
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <button
      type="button"
      onClick={onRetry}
      style={{ color: INK, background: "none", border: "none", font: "inherit", padding: 0, cursor: "pointer", textDecoration: "underline" }}
    >
      Retry
    </button>
  );
}

/** Translates the 1-based puzzle number in the URL into the internal day index. */
function ArchiveGame() {
  const { puzzle } = useParams<{ puzzle?: string }>();
  const n = Number(puzzle);
  // A non-numeric or out-of-range path falls through to today rather than
  // erroring; the server clamps anything that slips past this anyway.
  const requestedDay = Number.isInteger(n) && n >= 1 ? n - 1 : undefined;
  return <Game key={requestedDay} requestedDay={requestedDay} />;
}
