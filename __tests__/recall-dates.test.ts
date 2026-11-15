/**
 * Unit + integration tests for dated recall rendering (FOV-2735).
 *
 * - agePhrase / dateOnly / renderRecallItem formatting
 * - pilot gate: a bank NOT in recall_dates_banks produces today's output byte for byte
 * - the new header only when a recalled bank is gated
 *
 * Strategy mirrors mission-setup.test.ts: set process.env.HOME to a temp dir,
 * stub global fetch, and drive the real extension factory through a Pi mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import hindsight, {
  agePhrase,
  dateOnly,
  renderRecallItem,
  isDatedBank,
  RECALL_HEADER,
  RECALL_HEADER_DATED,
  type HindsightConfig,
} from "../index.ts";

// ---------------------------------------------------------------------------
// Unit tests: formatting helpers
// ---------------------------------------------------------------------------

const NOW = new Date("2026-11-15T12:00:00Z");
const DAY = 86400000;

describe("agePhrase", () => {
  it("says today for a timestamp hours ago", () => {
    expect(agePhrase("2026-11-15T09:00:00Z", NOW)).toBe("today");
  });

  it("says 1 day ago", () => {
    expect(agePhrase("2026-11-14T12:00:00Z", NOW)).toBe("1 day ago");
  });

  it("says N days ago for 2–14 days", () => {
    expect(agePhrase("2026-11-13T12:00:00Z", NOW)).toBe("2 days ago");
    expect(agePhrase("2026-11-01T12:00:00Z", NOW)).toBe("14 days ago");
  });

  it("says N weeks ago beyond 14 days", () => {
    expect(agePhrase("2026-10-31T12:00:00Z", NOW)).toBe("2 weeks ago");
    expect(agePhrase("2026-10-25T12:00:00Z", NOW)).toBe("3 weeks ago");
  });

  it("returns undefined for missing or unparseable dates", () => {
    expect(agePhrase(undefined, NOW)).toBeUndefined();
    expect(agePhrase(null, NOW)).toBeUndefined();
    expect(agePhrase("", NOW)).toBeUndefined();
    expect(agePhrase("not a date", NOW)).toBeUndefined();
  });
});

describe("dateOnly", () => {
  it("takes the date part of an ISO timestamp", () => {
    expect(dateOnly("2026-11-04T17:51:05Z")).toBe("2026-11-04");
  });

  it("falls back to toISOString for non-ISO parseable input", () => {
    expect(dateOnly("Nov 4, 2026")).toBe("2026-11-04");
  });

  it("returns undefined for missing input", () => {
    expect(dateOnly(undefined)).toBeUndefined();
  });
});

describe("renderRecallItem", () => {
  const result = {
    text: "The nice-decision-pdf skill is not installed",
    type: "observation",
    occurred_start: "2026-11-04T17:51:05Z",
  };

  it("keeps today's exact format when the bank is not gated", () => {
    expect(renderRecallItem("agent-secretary", result, false, NOW))
      .toBe("[Bank: agent-secretary] - The nice-decision-pdf skill is not installed");
  });

  it("renders type, age and absolute date when gated", () => {
    expect(renderRecallItem("agent-secretary", result, true, NOW))
      .toBe("[Bank: agent-secretary] - [observation, checked 10 days ago — 2026-11-04] The nice-decision-pdf skill is not installed");
  });

  it("prefers occurred_start over mentioned_at", () => {
    const both = { ...result, mentioned_at: "2026-11-10T00:00:00Z" };
    expect(renderRecallItem("b", both, true, NOW)).toContain("checked 10 days ago — 2026-11-04");
  });

  it("falls back to mentioned_at when occurred_start is missing", () => {
    const onlyMentioned = { text: "t", type: "world", mentioned_at: "2026-11-13T12:00:00Z" };
    expect(renderRecallItem("b", onlyMentioned, true, NOW))
      .toBe("[Bank: b] - [world, checked 2 days ago — 2026-11-13] t");
  });

  it("omits the type part when the fact has none", () => {
    const noType = { text: "t", occurred_start: "2026-11-15T09:00:00Z" };
    expect(renderRecallItem("b", noType, true, NOW))
      .toBe("[Bank: b] - [checked today — 2026-11-15] t");
  });

  it("says so when no date is present", () => {
    const noDate = { text: "t", type: "observation" };
    expect(renderRecallItem("b", noDate, true, NOW))
      .toBe("[Bank: b] - [observation, no date recorded] t");
  });
});

describe("isDatedBank", () => {
  const config: HindsightConfig = { recall_dates_banks: ["agent-secretary", "agent-overlord"] };
  it("matches listed banks", () => expect(isDatedBank(config, "agent-overlord")).toBe(true));
  it("does not match unlisted banks", () => expect(isDatedBank(config, "project-other")).toBe(false));
  it("is off when the key is absent", () => expect(isDatedBank({}, "agent-secretary")).toBe(false));
});

// ---------------------------------------------------------------------------
// Integration tests: the real extension factory through a Pi mock
// ---------------------------------------------------------------------------

type HookHandler = (event: any, ctx: any) => Promise<any>;

function makePiMock() {
  const handlers: Record<string, HookHandler[]> = {};
  return {
    on(event: string, handler: HookHandler) {
      (handlers[event] ||= []).push(handler);
    },
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    sendMessage() {},
    async emit(event: string, data: any, ctx: any) {
      let result: any;
      for (const h of handlers[event] || []) result = await h(data, ctx);
      return result;
    },
  };
}

describe("recall injection (before_agent_start)", () => {
  let homeDir: string;
  let projectDir: string;
  let envBackup: Record<string, string | undefined>;

  beforeEach(() => {
    envBackup = {
      HINDSIGHT_BANK_ID: process.env.HINDSIGHT_BANK_ID,
      HINDSIGHT_SCOPING: process.env.HINDSIGHT_SCOPING,
    };
    delete process.env.HINDSIGHT_BANK_ID;
    delete process.env.HINDSIGHT_SCOPING;
    homeDir = mkdtempSync(join(tmpdir(), "hindsight-dates-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "hindsight-dates-proj-"));
    process.env.HOME = homeDir;
    mkdirSync(join(homeDir, ".hindsight"), { recursive: true });
  });

  afterEach(() => {
    process.env.HINDSIGHT_BANK_ID = envBackup.HINDSIGHT_BANK_ID;
    process.env.HINDSIGHT_SCOPING = envBackup.HINDSIGHT_SCOPING;
    delete process.env.HINDSIGHT_BANK_ID;
    delete process.env.HINDSIGHT_SCOPING;
    for (const [k, v] of Object.entries(envBackup)) if (v !== undefined) process.env[k] = v;
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  const writeConfig = (extra: Record<string, string>) => {
    writeFileSync(
      join(homeDir, ".hindsight", "config"),
      `api_url = "http://localhost:4000"\napi_key = "test-key"\nglobal_bank = "agent-secretary"\n` +
        Object.entries(extra).map(([k, v]) => `${k} = "${v}"`).join("\n") + "\n",
    );
  };

  const runRecall = async () => {
    // Age relative to real wall time; 10.5 days back floors to "10 days ago".
    const occurred = new Date(Date.now() - 10.5 * DAY).toISOString();
    const results = [
      {
        text: "The nice-decision-pdf skill is not installed",
        type: "observation",
        occurred_start: occurred,
      },
      { text: "A bare mention from JC = a request for a decision summary", type: "observation" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results }),
    })));

    const pi: any = makePiMock();
    hindsight(pi);
    const ctx = {
      cwd: projectDir,
      ui: { setStatus: () => {}, notify: () => {} },
      sessionManager: {
        getEntries: () => [{ type: "message", message: { role: "user", content: "build a decision page" } }],
        getSessionId: () => "test-session",
      },
    };
    await pi.emit("session_start", {}, ctx);
    const out = await pi.emit("before_agent_start", {}, ctx);
    return { out, occurred };
  };

  it("shows the new header and dated items when the bank is gated", async () => {
    writeConfig({ recall_dates_banks: "agent-secretary" });
    const { out, occurred } = await runRecall();
    const content: string = out?.message?.content ?? "";
    expect(content).toContain(`<hindsight_memories>\n${RECALL_HEADER_DATED}\n`);
    expect(content).toContain(
      `[Bank: agent-secretary] - [observation, checked 10 days ago — ${occurred.slice(0, 10)}] The nice-decision-pdf skill is not installed`,
    );
    // no date on the second item → "no date recorded"
    expect(content).toContain("[observation, no date recorded] A bare mention");
    // the ungated project bank keeps today's format
    expect(content).toContain(
      `[Bank: project-${projectDir.split("/").pop()}] - A bare mention from JC = a request for a decision summary`,
    );
  });

  it("keeps today's output byte for byte when no bank is gated", async () => {
    writeConfig({});
    const { out } = await runRecall();
    const content: string = out?.message?.content ?? "";
    expect(content).toContain(`<hindsight_memories>\n${RECALL_HEADER}\n`);
    expect(content).not.toContain("checked");
    expect(content).toContain("[Bank: agent-secretary] - The nice-decision-pdf skill is not installed");
  });
});
