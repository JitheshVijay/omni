// Pure-helper tests for the podcast generator: turn budgeting, the CBR
// byte->seconds estimate, and script-shape validation. No LLM or TTS calls.
//
// IMPORTANT: podcast.ts imports @omni/sdk, which resolves DATA_DIR and opens
// the SQLite file at import time, so OMNI_DATA_DIR (and the env vars
// env-config requires) must be set BEFORE the module loads. Static imports
// hoist above any statement, so podcast.ts is loaded with dynamic import()
// after the env setup below (same pattern as doc.test.ts).

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "omni-podcast-test-"));
process.env.OPENROUTER_API_KEY ??= "test-key-not-used";
process.env.NODE_ENV ??= "test";

const {
  turnBudgetForMinutes,
  bytesToSeconds,
  validateScript,
  MP3_BYTES_PER_SEC,
  WORDS_PER_MINUTE,
  MIN_TURNS,
  MAX_TURNS,
  PODCAST_VOICE_A,
  PODCAST_VOICE_B,
} = await import("./podcast.js");
const { VOICE_CATALOG } = await import("../lib/voice-catalog.js");

describe("turnBudgetForMinutes", () => {
  it("budgets ~150 words per minute", () => {
    expect(turnBudgetForMinutes(1).words).toBe(WORDS_PER_MINUTE);
    expect(turnBudgetForMinutes(3).words).toBe(3 * WORDS_PER_MINUTE);
    expect(turnBudgetForMinutes(10).words).toBe(10 * WORDS_PER_MINUTE);
  });

  it("targets 3 turns per minute within the 6-20 clamp", () => {
    expect(turnBudgetForMinutes(1).turns).toBe(MIN_TURNS); // 3 -> clamped up
    expect(turnBudgetForMinutes(3).turns).toBe(9);
    expect(turnBudgetForMinutes(6).turns).toBe(18);
    expect(turnBudgetForMinutes(7).turns).toBe(MAX_TURNS); // 21 -> clamped down
    expect(turnBudgetForMinutes(10).turns).toBe(MAX_TURNS);
  });

  it("clamps out-of-range minutes into 1..10", () => {
    expect(turnBudgetForMinutes(0)).toEqual(turnBudgetForMinutes(1));
    expect(turnBudgetForMinutes(-5)).toEqual(turnBudgetForMinutes(1));
    expect(turnBudgetForMinutes(99)).toEqual(turnBudgetForMinutes(10));
  });
});

describe("bytesToSeconds", () => {
  it("converts at 16,000 bytes per second (128kbps CBR)", () => {
    expect(bytesToSeconds(MP3_BYTES_PER_SEC)).toBe(1);
    expect(bytesToSeconds(8_000)).toBe(0.5);
    expect(bytesToSeconds(160_000)).toBe(10);
  });

  it("rounds to two decimals", () => {
    expect(bytesToSeconds(1_000)).toBe(0.06); // 0.0625 -> 0.06
    expect(bytesToSeconds(50_000)).toBe(3.13); // 3.125 -> 3.13
  });

  it("returns 0 for zero, negative, and non-finite input", () => {
    expect(bytesToSeconds(0)).toBe(0);
    expect(bytesToSeconds(-100)).toBe(0);
    expect(bytesToSeconds(Number.NaN)).toBe(0);
    expect(bytesToSeconds(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("produces cumulative seek offsets from byte offsets", () => {
    const turnBytes = [32_000, 16_000, 48_000]; // 2s, 1s, 3s
    let offset = 0;
    const starts = turnBytes.map((b) => {
      const start = bytesToSeconds(offset);
      offset += b;
      return start;
    });
    expect(starts).toEqual([0, 2, 3]);
    expect(bytesToSeconds(offset)).toBe(6); // total duration
  });
});

describe("validateScript", () => {
  it("passes a well-formed script through, trimming text", () => {
    const script = validateScript({
      title: " Why Sleep Matters ",
      turns: [
        { speaker: "A", text: "  Welcome to the show! " },
        { speaker: "B", text: "Thanks for having me." },
      ],
    });
    expect(script.title).toBe("Why Sleep Matters");
    expect(script.turns).toEqual([
      { speaker: "A", text: "Welcome to the show!" },
      { speaker: "B", text: "Thanks for having me." },
    ]);
  });

  it("normalizes loose speaker labels", () => {
    const script = validateScript({
      title: "t",
      turns: [
        { speaker: "a", text: "one" },
        { speaker: "Host B", text: "two" },
        { speaker: "HOST A:", text: "three" },
        { speaker: "speaker b", text: "four" },
      ],
    });
    expect(script.turns.map((t) => t.speaker)).toEqual(["A", "B", "A", "B"]);
  });

  it("alternates from A for unrecognizable speakers", () => {
    const script = validateScript({
      turns: [
        { speaker: "narrator", text: "one" },
        { speaker: 7, text: "two" },
        { text: "three" },
      ],
    });
    expect(script.turns.map((t) => t.speaker)).toEqual(["A", "B", "A"]);
  });

  it("drops empty/non-string turns and caps at MAX_TURNS", () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      speaker: i % 2 === 0 ? "A" : "B",
      text: `turn ${i}`,
    }));
    const withJunk = [
      { speaker: "A", text: "   " },
      { speaker: "B", text: null },
      "not a turn",
      ...many,
    ];
    const script = validateScript({ title: "t", turns: withJunk });
    expect(script.turns).toHaveLength(MAX_TURNS);
    expect(script.turns[0].text).toBe("turn 0");
  });

  it("tolerates a missing title (caller supplies the fallback)", () => {
    expect(validateScript({ turns: [{ speaker: "A", text: "hi" }] }).title).toBe("");
    expect(validateScript({ title: 42, turns: [{ speaker: "A", text: "hi" }] }).title).toBe("");
  });

  it("throws when nothing speakable survives", () => {
    expect(() => validateScript(null)).toThrow(/no usable turns/i);
    expect(() => validateScript({ title: "t", turns: [] })).toThrow(/no usable turns/i);
    expect(() =>
      validateScript({ title: "t", turns: [{ speaker: "A", text: "" }] }),
    ).toThrow(/no usable turns/i);
    expect(() => validateScript({ title: "t" })).toThrow(/no usable turns/i);
  });
});

describe("default host voices", () => {
  it("are two DIFFERENT entries from the shared voice catalog", () => {
    expect(PODCAST_VOICE_A).not.toBe(PODCAST_VOICE_B);
    const ids = VOICE_CATALOG.map((v) => v.id);
    expect(ids).toContain(PODCAST_VOICE_A);
    expect(ids).toContain(PODCAST_VOICE_B);
  });
});
