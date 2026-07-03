// Pure-helper tests for the doc generator: the citation-token regex and
// title extraction. No LLM calls.
//
// IMPORTANT: doc.ts imports @omni/sdk, which resolves DATA_DIR and opens
// the SQLite file at import time, so OMNI_DATA_DIR (and the env vars
// env-config requires) must be set BEFORE the module loads. Static imports
// hoist above any statement, so doc.ts is loaded with dynamic import()
// after the env setup below (same pattern as packages/sdk/src/db.test.ts).

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "omni-doc-test-"));
process.env.OPENROUTER_API_KEY ??= "test-key-not-used";
process.env.NODE_ENV ??= "test";

const { CITE_TOKEN_RE, extractTitle, titleFromPrompt } = await import("./doc.js");

describe("CITE_TOKEN_RE", () => {
  it("matches [[cite:IDX:LABEL]] and captures idx + label", () => {
    const matches = [..."Fact one [[cite:2:Page 3]].".matchAll(CITE_TOKEN_RE)];
    expect(matches).toHaveLength(1);
    expect(matches[0][1]).toBe("2");
    expect(matches[0][2]).toBe("Page 3");
  });

  it("matches multiple tokens across a document", () => {
    const md =
      "Alpha [[cite:1:Page 1]] then beta [[cite:12:report.pdf p4]] and gamma [[cite:3:Chat note]].";
    const matches = [...md.matchAll(CITE_TOKEN_RE)];
    expect(matches.map((m) => m[1])).toEqual(["1", "12", "3"]);
    expect(matches.map((m) => m[2])).toEqual(["Page 1", "report.pdf p4", "Chat note"]);
  });

  it("does not match malformed tokens", () => {
    for (const bad of [
      "[[cite:Page 3]]", // missing idx
      "[[cite:x:Page 3]]", // non-numeric idx
      "[cite:1:Page 3]", // single brackets
      "[[cite:1:]]", // empty label
    ]) {
      expect([...bad.matchAll(CITE_TOKEN_RE)]).toHaveLength(0);
    }
  });
});

describe("extractTitle", () => {
  it("returns the first H1 line", () => {
    expect(extractTitle("# Quarterly Report\n\nBody text.")).toBe("Quarterly Report");
  });

  it("skips leading blank lines and finds a later H1", () => {
    expect(extractTitle("\n\nIntro paragraph.\n\n# The Real Title\n\nMore.")).toBe(
      "The Real Title",
    );
  });

  it("ignores deeper headings and returns null without an H1", () => {
    expect(extractTitle("## Section\n\n### Sub\n\nText.")).toBeNull();
    expect(extractTitle("plain text only")).toBeNull();
  });

  it("trims trailing closing hashes", () => {
    expect(extractTitle("# Title ##\n\nBody")).toBe("Title");
  });
});

describe("titleFromPrompt", () => {
  it("flattens whitespace and passes short prompts through", () => {
    expect(titleFromPrompt("Write a memo\nabout    onboarding")).toBe(
      "Write a memo about onboarding",
    );
  });

  it("clips long prompts to 80 chars with an ellipsis", () => {
    const long = "word ".repeat(40).trim();
    const title = titleFromPrompt(long);
    expect(title.length).toBeLessThanOrEqual(80);
    expect(title.endsWith("...")).toBe(true);
  });
});
