// Pure-helper tests for the realtime voice agent: the hub-memory digest
// builder and the system-prompt assembler. No ElevenLabs calls, no DB.
//
// voice-agent.ts imports @omni/sdk (which resolves DATA_DIR + opens SQLite at
// import time) and @omni/env-config, so the env vars they require must be set
// BEFORE the module loads. Static imports hoist, so we set env first then
// dynamic-import (same pattern as sheet.test.ts / doc.test.ts).

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "omni-voice-test-"));
process.env.OPENROUTER_API_KEY ??= "test-key-not-used";
process.env.NODE_ENV ??= "test";

const { buildHubDigest, buildVoiceSystemPrompt } = await import("./voice-agent.js");

describe("buildHubDigest", () => {
  it("returns empty string with no files or chunks", () => {
    expect(buildHubDigest({})).toBe("");
    expect(buildHubDigest({ fileNames: [], chunks: [] })).toBe("");
  });

  it("lists attached file names first", () => {
    const out = buildHubDigest({ fileNames: ["Q3 Report.pdf", "Roadmap.md"] });
    expect(out).toBe("Attached documents: Q3 Report.pdf, Roadmap.md.");
  });

  it("skips blank file names and blank chunks", () => {
    const out = buildHubDigest({
      fileNames: ["  ", "Notes.txt"],
      chunks: [{ chunk_text: "   " }, { chunk_text: "Real content." }],
    });
    expect(out).toContain("Attached documents: Notes.txt.");
    expect(out).toContain("Real content.");
    // Only one real chunk line beyond the files line.
    expect(out.split("\n")).toHaveLength(2);
  });

  it("prefixes chunks with cite label and section title", () => {
    const out = buildHubDigest({
      chunks: [
        { cite_label: "F1", section_title: "Intro", chunk_text: "Alpha beta gamma." },
      ],
    });
    expect(out).toBe("[F1] (Intro) Alpha beta gamma.");
  });

  it("collapses internal whitespace in chunk text", () => {
    const out = buildHubDigest({
      chunks: [{ chunk_text: "line one\n\n  line   two\t" }],
    });
    expect(out).toBe("line one line two");
  });

  it("caps total length and never cuts mid-word", () => {
    const long = "word ".repeat(500).trim(); // ~2500 chars
    const out = buildHubDigest({ chunks: [{ chunk_text: long }] }, 200);
    expect(out.length).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
    // No dangling partial "wor" token before the ellipsis.
    expect(out).not.toMatch(/\bwor\s*…$/);
  });

  it("stops packing chunks once the cap is reached", () => {
    const out = buildHubDigest(
      {
        chunks: [
          { chunk_text: "A".repeat(90) },
          { chunk_text: "B".repeat(90) },
          { chunk_text: "C".repeat(90) },
        ],
      },
      100,
    );
    expect(out).toContain("A".repeat(90));
    // Second/third chunks don't fit under a 100-char cap.
    expect(out).not.toContain("B".repeat(90));
    expect(out).not.toContain("C".repeat(90));
  });
});

describe("buildVoiceSystemPrompt", () => {
  it("uses the general persona when no hub is given", () => {
    const p = buildVoiceSystemPrompt({ today: "2026-07-04" });
    expect(p).toContain("general voice assistant");
    expect(p).toContain("Today's date is 2026-07-04.");
    expect(p).not.toContain("HUB INSTRUCTIONS");
    expect(p).not.toContain("HUB MEMORY");
  });

  it("grounds to the hub and includes instructions + digest when present", () => {
    const p = buildVoiceSystemPrompt({
      hubName: "Acme Docs",
      instructions: "Be terse. Prefer tables.",
      digest: "[F1] Alpha.",
      today: "2026-07-04",
    });
    expect(p).toContain('grounded in the user\'s hub "Acme Docs"');
    expect(p).toContain("═══ HUB INSTRUCTIONS ═══");
    expect(p).toContain("Be terse. Prefer tables.");
    expect(p).toContain("═══ HUB MEMORY (excerpts from attached documents) ═══");
    expect(p).toContain("[F1] Alpha.");
  });

  it("omits empty instruction / digest sections", () => {
    const p = buildVoiceSystemPrompt({
      hubName: "Acme",
      instructions: "   ",
      digest: "",
      today: "2026-07-04",
    });
    expect(p).not.toContain("HUB INSTRUCTIONS");
    expect(p).not.toContain("HUB MEMORY");
  });

  it("truncates very long instructions", () => {
    const p = buildVoiceSystemPrompt({
      hubName: "Acme",
      instructions: "x".repeat(9000),
      today: "2026-07-04",
    });
    // Capped at 4000 chars; the whole prompt stays well under 9000.
    expect(p.length).toBeLessThan(6000);
  });
});
