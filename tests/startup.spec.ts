import { expect, test, type Page, type WebSocketRoute } from "@playwright/test";
import { build } from "esbuild";

// Bundle the real application and SDK. Only the HTTP/WebSocket server is a
// fixture; these tests never contact Lakebed or read production puzzle data.
const origin = "http://localhost:4188";
const auth = {
  displayName: "Test guest", isAuthenticated: false, isGuest: true,
  isSignedIn: false, provider: "guest", userId: "guest:startup-test"
};
const items = ["one", "two", "three", "four", "five"].map(name => ({ slug: `fixture/${name}` }));
let bundle: string;

function gate() {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  return { wait, release };
}

test.beforeAll(async () => {
  const output = await build({
    stdin: {
      contents: 'import { h, render } from "preact"; import { App } from "./client/index.tsx"; render(h(App, {}), document.getElementById("app"));',
      resolveDir: process.cwd(), loader: "tsx"
    },
    bundle: true, platform: "browser", format: "esm", jsx: "automatic",
    jsxImportSource: "preact", write: false, metafile: true
  });
  expect(Object.keys(output.metafile!.inputs).some(path => path.startsWith("server/"))).toBe(false);
  bundle = output.outputFiles![0].text;
});

async function setup(page: Page, options: {
  initialSession?: boolean;
  sessionGate?: Promise<void>;
  queryGate?: Promise<void>;
  sessionError?: boolean;
  queryError?: boolean;
} = {}) {
  const state = {
    sessionCalls: 0, queryCalls: 0, queryBeforeSession: false,
    sessionReady: !!options.initialSession, sessionError: !!options.sessionError,
    queryError: !!options.queryError, submissions: [] as any[],
    sessions: {} as Record<string, any>, clientKeys: [] as string[], errors: [] as string[]
  };
  const today = (day = 72) => ({
    ready: true, day, current: 72, isArchive: day !== 72, stat: "stars",
    prompt: "order by stars, most first", phrase: "stars, most first", items,
    budget: { easy: 5, hard: 3 }, sessions: state.sessions
  });
  const archive = {
    month: "2026-10", label: "October 2026", current: 72,
    days: [{ day: 71, stat: "stars", played: false, finished: false, top: null }],
    totals: { played: 0, solved: 0 }, prev: "2026-09", next: null
  };
  const active = new Map<WebSocketRoute, Map<string, any>>();
  const sendQuery = (ws: WebSocketRoute, message: any) => {
    const args = message.args[0] ?? {};
    const data = message.name === "archive" ? archive
      : message.name === "results" ? { total: 0, buckets: {} }
      : today(args.day);
    ws.send(JSON.stringify({ op: "query.result", name: message.name, args: message.args, data }));
  };
  page.on("pageerror", error => state.errors.push(error.message));
  await page.route("**/*", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/client.js") return route.fulfill({ contentType: "application/javascript", body: bundle });
    if (path === "/__lakebed/auth/session") {
      state.sessionCalls++;
      await options.sessionGate;
      if (state.sessionError) return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Test session unavailable"}' });
      state.sessionReady = true;
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ auth, requireSignIn: false }) });
    }
    if (path.startsWith("/__lakebed/")) return route.fulfill({ status: 404, body: "{}" });
    const config = { requireSignIn: false, ...(options.initialSession ? { session: { auth } } : {}) };
    return route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><div id="app"></div><script>window.__LAKEBED_BASE_PATH__="";window.__LAKEBED_AUTH__=${JSON.stringify(config)};</script><script type="module" src="/client.js"></script></body></html>`
    });
  });
  await page.routeWebSocket(`${origin.replace("http:", "ws:")}/__lakebed/ws`, ws => {
    const queries = new Map<string, any>();
    active.set(ws, queries);
    ws.onClose(() => active.delete(ws));
    ws.onMessage(async raw => {
      const message = JSON.parse(String(raw));
      if (message.op === "auth.get") return ws.send(JSON.stringify({ op: "auth.result", auth }));
      if (message.op === "query.subscribe") {
        state.queryCalls++;
        if (!state.sessionReady) state.queryBeforeSession = true;
        const args = message.args[0] ?? {};
        if (args.clientKey) state.clientKeys.push(args.clientKey);
        queries.set(message.name, message);
        await options.queryGate;
        if (state.queryError) return ws.send(JSON.stringify({ op: "query.error", name: message.name, args: message.args, error: "Test query unavailable" }));
        return sendQuery(ws, message);
      }
      if (message.op === "mutation.run") {
        const args = message.args[0];
        state.submissions.push(args);
        const session = {
          guesses: [args.order], marks: [[false, false, false, false, false]],
          solved: false, finished: false, reveal: null
        };
        state.sessions[args.mode] = session;
        ws.send(JSON.stringify({ op: "mutation.result", id: message.id, ok: true, result: { ok: true, ...session, isArchive: false } }));
        for (const [connection, subscriptions] of active) {
          for (const subscription of subscriptions.values()) sendQuery(connection, subscription);
        }
      }
    });
  });
  return state;
}

const submit = (page: Page) => page.getByRole("button", { name: "submit", exact: true });
const rows = (page: Page) => page.getByRole("listitem", { name: /^Slot / });

test("session-request fallback waits before queries and shows progress", async ({ page }) => {
  const session = gate();
  const state = await setup(page, { sessionGate: session.wait });
  await page.goto(origin);
  await expect(page.getByRole("status")).toHaveText("Connecting to the game...");
  expect(state.queryCalls).toBe(0);
  session.release();
  await expect(submit(page)).toBeVisible();
  expect(state.queryBeforeSession).toBe(false);
  expect(state.sessionCalls).toBe(1);
  expect(state.errors).toEqual([]);
});

test("0.0.40 HTML-provided guest session avoids an extra session request", async ({ page }) => {
  const state = await setup(page, { initialSession: true });
  await page.goto(origin);
  await expect(rows(page)).toHaveCount(5);
  expect(state.sessionCalls).toBe(0);
  expect(state.queryBeforeSession).toBe(false);
});

test("slow puzzle queries display loading instead of an empty page", async ({ page }) => {
  const query = gate();
  await setup(page, { queryGate: query.wait });
  await page.goto(origin);
  await expect(page.getByRole("status")).toHaveText("Loading puzzle...");
  query.release();
  await expect(submit(page)).toBeVisible();
});

test("swapping, submission, reload, and saved browser identity still work", async ({ page }) => {
  const key = "existing-player-key";
  const streak = JSON.stringify({ current: 3, best: 5, lastDay: 71, played: 8, wins: 7 });
  await page.addInitScript(({ key, streak }) => {
    if (!localStorage.getItem("bubblesort.clientKey")) localStorage.setItem("bubblesort.clientKey", key);
    if (!localStorage.getItem("bubblesort.streak.easy")) localStorage.setItem("bubblesort.streak.easy", streak);
  }, { key, streak });
  const state = await setup(page);
  await page.goto(origin);
  await expect(rows(page)).toHaveCount(5);
  await rows(page).nth(0).click();
  await rows(page).nth(1).click();
  await expect(rows(page).nth(0)).toContainText("fixture/two");
  expect(state.submissions).toHaveLength(0);
  await submit(page).click();
  await expect(page.getByText("4 left", { exact: true })).toBeVisible();
  expect(state.submissions[0]).toEqual({ clientKey: key, mode: "easy", order: [1, 0, 2, 3, 4], day: 72 });
  await page.reload();
  await expect(page.getByText("4 left", { exact: true })).toBeVisible();
  await expect(rows(page).nth(0)).toContainText("fixture/two");
  expect(state.clientKeys.every(value => value === key)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("bubblesort.streak.easy"))).toBe(streak);
  expect(state.errors).toEqual([]);
});

test("archive links and direct past-puzzle routes load", async ({ page }) => {
  const state = await setup(page);
  await page.goto(origin);
  await page.getByRole("link", { name: "archive", exact: true }).click();
  await expect(page.getByText("October 2026", { exact: true })).toBeVisible();
  await page.goto(`${origin}/72`);
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByText(/no streak/)).toBeVisible();
  expect(state.errors).toEqual([]);
});

test("session failure exposes Retry and recovers", async ({ page }) => {
  const state = await setup(page, { sessionError: true });
  await page.goto(origin);
  await expect(page.getByRole("alert")).toContainText("Could not load your session");
  expect(state.queryCalls).toBe(0);
  state.sessionError = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(submit(page)).toBeVisible();
  expect(state.sessionCalls).toBe(2);
  expect(state.errors).toEqual([]);
});

test("query failure exposes Retry and clears the failed query cache", async ({ page }) => {
  const state = await setup(page, { queryError: true });
  await page.goto(origin);
  await expect(page.getByRole("alert")).toContainText("Test query unavailable");
  state.queryError = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(submit(page)).toBeVisible();
  expect(state.errors).toEqual([]);
});
