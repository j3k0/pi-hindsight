/**
 * FOV-2756: the retention opt-out (#nomem / #skip), the #global/#me tag routing,
 * and the trivial-prompt skip all match against the text of the last user
 * message. On pi 1.5.2 user messages are stored as an array of content blocks,
 * so getLastUserMessage must join the text blocks — not JSON.stringify the
 * array — or every filter misses and everything gets retained.
 *
 * These tests drive a real pi session (harness), whose user messages are
 * arrays of blocks exactly like production, and watch the mocked hindsight API
 * for POSTs to <bank>/memories (the auto-retain call).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { createTestSession, type TestSession } from "@marcfargas/pi-test-harness";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const EXTENSION = path.resolve(__dirname, "../index.ts");

// pi-test-harness 0.6.1 imports `getModel` from pi-ai, removed in 1.5.2.
// The model is never actually streamed (playbook replaces streamFn) — hand the
// harness a faux model so session creation passes validation.
vi.mock("@earendil-works/pi-ai", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { fauxProvider } = actual as typeof import("@earendil-works/pi-ai");
  const faux = fauxProvider();
  return { ...actual, getModel: () => faux.models[0] };
});

const RETAIN_BANK = "test-global";

// pi 1.5.2 moved two knobs the harness patches: auth now flows through
// session.modelRuntime (the old _modelRegistry) and the agent's stream function
// is agent.streamFunction (the old agent.streamFn). Patch both the same way.
function patchSessionCompat(t: TestSession) {
  const rt = (t.session as any).modelRuntime;
  if (rt) {
    rt.getAuth = async () => ({ auth: { apiKey: "test-key" } });
    rt.hasConfiguredAuth = () => true;
    rt.isUsingOAuth = () => false;
  }
  const agent = (t.session as any).agent;
  if (agent && !("streamFn" in agent)) {
    Object.defineProperty(agent, "streamFn", {
      get: () => agent.streamFunction,
      set: (v) => { agent.streamFunction = v; },
      configurable: true,
    });
  }
}

function setupFetchSpy() {
  const fetchCalls: { url: string; method: string; body?: any }[] = [];
  globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method || "GET";
    let body: any;
    if (init?.body) {
      try { body = JSON.parse(init.body as string); } catch { body = init.body; }
    }
    fetchCalls.push({ url, method, body });

    if (url.includes("/health")) {
      return new Response(JSON.stringify({ status: "healthy" }), { status: 200 });
    }
    if (url.includes("/recall")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (url.includes("/config")) {
      return new Response(JSON.stringify({
        config: { retain_mission: null, observations_mission: null },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as any;
  return fetchCalls;
}

describe("auto-retain opt-out with array-of-blocks user messages (pi 1.5.2 format)", () => {
  let t: TestSession;
  let tmpHome: string;
  let fetchCalls: { url: string; method: string; body?: any }[];
  let originalFetch: typeof globalThis.fetch;
  let originalHome: string;
  let envKeys: string[] = [];

  const retainPosts = () =>
    fetchCalls.filter(
      (c) => c.method === "POST" && /\/memories(\/|$)/.test(c.url) && !c.url.includes("/recall"),
    );
  const postsToBank = (bank: string) =>
    retainPosts().filter((c) => c.url.includes(`/banks/${bank}/memories`));

  beforeEach(() => {
    fetchCalls = [];
    originalFetch = globalThis.fetch;
    originalHome = process.env.HOME!;
    fetchCalls = setupFetchSpy()!;

    // Temp HOME so cache + config don't touch real files
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "retain-optout-test-"));
    process.env.HOME = tmpHome;

    // FOV-2735 env overrides must not leak in — they reroute the banks
    for (const key of ["HINDSIGHT_BANK_ID", "HINDSIGHT_SCOPING"]) {
      if (process.env[key] !== undefined) {
        envKeys.push(key);
        delete process.env[key];
      }
    }

    const hindsightDir = path.join(tmpHome, ".hindsight");
    fs.mkdirSync(hindsightDir, { recursive: true });
    fs.writeFileSync(
      path.join(hindsightDir, "config"),
      [
        'api_url = "http://localhost:19876"',
        'api_key = "test-key"',
        `global_bank = "${RETAIN_BANK}"`,
      ].join("\n"),
    );
  });

  afterEach(() => {
    t?.dispose();
    globalThis.fetch = originalFetch;
    process.env.HOME = originalHome;
    if (fs.existsSync(tmpHome)) {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it("retains a normal prompt (control — the array-of-blocks format is readable)", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });
    patchSessionCompat(t);

    await t.run({
      prompt: "Remember that I always prefer tabs over spaces in this project.",
      actions: [{ type: "say", text: "Noted — tabs over spaces it is." }],
    });
    await new Promise((r) => setTimeout(r, 500));

    expect(retainPosts().length).toBeGreaterThanOrEqual(1);
  });

  it("skips retain on a #nomem prompt", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });
    patchSessionCompat(t);

    await t.run({
      prompt: "#nomem Reply with exactly: OK",
      actions: [{ type: "say", text: "OK" }],
    });
    await new Promise((r) => setTimeout(r, 500));

    expect(retainPosts().length).toBe(0);
  });

  it("skips retain on a #skip prompt", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });
    patchSessionCompat(t);

    await t.run({
      prompt: "#skip Just tell me the time, nothing else.",
      actions: [{ type: "say", text: "It is noon." }],
    });
    await new Promise((r) => setTimeout(r, 500));

    expect(retainPosts().length).toBe(0);
  });

  it("skips retain on a trivial prompt", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });
    patchSessionCompat(t);

    await t.run({
      prompt: "thanks",
      actions: [{ type: "say", text: "You're welcome, anything else?" }],
    });
    await new Promise((r) => setTimeout(r, 500));

    expect(retainPosts().length).toBe(0);
  });

  it("routes a #global-tagged prompt to the global bank", async () => {
    t = await createTestSession({
      extensions: [EXTENSION],
      mockTools: { bash: "ok", read: "ok", write: "ok", edit: "ok" },
    });
    patchSessionCompat(t);

    await t.run({
      prompt: "#global Remember that I prefer concise email updates.",
      actions: [{ type: "say", text: "Got it — concise email updates." }],
    });
    await new Promise((r) => setTimeout(r, 500));

    // Without reading the blocks, the #global tag never matched and the
    // global bank was never added to the retain list.
    expect(postsToBank(RETAIN_BANK).length).toBeGreaterThanOrEqual(1);
  });
});
