// Pure-helper tests for the sheet generator: cell coercion, the NDJSON
// line parser (single-line + stateful chunked variants), column/row
// normalization, and the revise-prompt serializer. No LLM calls.
//
// IMPORTANT: sheet.ts imports @omni/sdk, which resolves DATA_DIR and opens
// the SQLite file at import time, so OMNI_DATA_DIR (and the env vars
// env-config requires) must be set BEFORE the module loads. Static imports
// hoist above any statement, so sheet.ts is loaded with dynamic import()
// after the env setup below (same pattern as doc.test.ts).

import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.OMNI_DATA_DIR = mkdtempSync(path.join(tmpdir(), "omni-sheet-test-"));
process.env.OPENROUTER_API_KEY ??= "test-key-not-used";
process.env.NODE_ENV ??= "test";

const {
  coerceCell,
  parseRowLine,
  createNdjsonRowParser,
  normalizeColumns,
  normalizeRows,
  serializeSheetForPrompt,
} = await import("./sheet.js");

import type { SheetColumn } from "./sheet.js";

const COLS: SheetColumn[] = [
  { name: "Name", type: "text" },
  { name: "Price", type: "number" },
  { name: "Released", type: "date" },
  { name: "Site", type: "url" },
];

describe("coerceCell", () => {
  it("passes finite numbers through for number columns", () => {
    expect(coerceCell(42, "number")).toBe(42);
    expect(coerceCell(-3.25, "number")).toBe(-3.25);
  });

  it("parses numeric strings, tolerating $, %, commas, whitespace", () => {
    expect(coerceCell("42", "number")).toBe(42);
    expect(coerceCell(" 1,234.56 ", "number")).toBe(1234.56);
    expect(coerceCell("$1,200", "number")).toBe(1200);
    expect(coerceCell("45%", "number")).toBe(45);
  });

  it("keeps unparseable number-column values as trimmed strings", () => {
    expect(coerceCell("n/a", "number")).toBe("n/a");
    expect(coerceCell(" 3.5x ", "number")).toBe("3.5x");
  });

  it("normalizes null / undefined / empty / non-finite to null", () => {
    expect(coerceCell(null, "text")).toBeNull();
    expect(coerceCell(undefined, "number")).toBeNull();
    expect(coerceCell("", "number")).toBeNull(); // NOT Number("") === 0
    expect(coerceCell("   ", "text")).toBeNull();
    expect(coerceCell(Number.NaN, "number")).toBeNull();
    expect(coerceCell(Infinity, "number")).toBeNull();
  });

  it("stringifies non-string primitives and objects for text columns", () => {
    expect(coerceCell(" hi ", "text")).toBe("hi");
    expect(coerceCell(7, "text")).toBe(7); // numbers stay numbers
    expect(coerceCell(true, "text")).toBe("true");
    expect(coerceCell({ a: 1 }, "text")).toBe('{"a":1}');
  });
});

describe("parseRowLine", () => {
  it("parses a valid flat array line, coercing by column type", () => {
    const row = parseRowLine(
      '["Widget", "1,299", "2024-05-01", "https://example.com"]',
      COLS,
    );
    expect(row).toEqual(["Widget", 1299, "2024-05-01", "https://example.com"]);
  });

  it("pads short rows with null and drops extra cells", () => {
    expect(parseRowLine('["Widget", 5]', COLS)).toEqual(["Widget", 5, null, null]);
    expect(parseRowLine('["A", 1, "2024-01-01", "https://a.com", "extra"]', COLS)).toEqual(
      ["A", 1, "2024-01-01", "https://a.com"],
    );
  });

  it("tolerates a trailing comma (pretty-printed array-of-arrays)", () => {
    expect(parseRowLine('["Widget", 5, null, null],', COLS)).toEqual([
      "Widget",
      5,
      null,
      null,
    ]);
  });

  it("returns null for malformed / non-row lines", () => {
    for (const bad of [
      "", // blank
      "   ", // whitespace
      "```json", // code fence
      "Here are the rows:", // prose
      '{"Name": "Widget"}', // object, not array
      '["unterminated', // invalid JSON
      "[", // opening bracket of a wrapping array
      "]", // closing bracket
      "[[1,2],[3,4]]", // nested batch on one line
    ]) {
      expect(parseRowLine(bad, COLS)).toBeNull();
    }
  });
});

describe("createNdjsonRowParser", () => {
  it("buffers partial lines across chunk boundaries", () => {
    const p = createNdjsonRowParser(COLS);
    expect(p.push('["Widg')).toEqual([]);
    expect(p.push('et", 9, "2024-01-02", null]\n["Ga')).toEqual([
      ["Widget", 9, "2024-01-02", null],
    ]);
    expect(p.push('dget", "12", null, "https://g.com"]\n')).toEqual([
      ["Gadget", 12, null, "https://g.com"],
    ]);
    expect(p.flush()).toEqual([]);
  });

  it("flushes a trailing line without a final newline", () => {
    const p = createNdjsonRowParser(COLS);
    expect(p.push('["A", 1, null, null]')).toEqual([]);
    expect(p.flush()).toEqual([["A", 1, null, null]]);
    // flush drains the buffer — a second flush yields nothing
    expect(p.flush()).toEqual([]);
  });

  it("skips malformed lines silently and handles CRLF", () => {
    const p = createNdjsonRowParser(COLS);
    const rows = p.push(
      '```json\r\n["A", 1, null, null]\r\nsome prose\r\n["B", 2, null, null]\r\n```\r\n',
    );
    expect(rows).toEqual([
      ["A", 1, null, null],
      ["B", 2, null, null],
    ]);
  });

  it("emits multiple rows arriving in one chunk", () => {
    const p = createNdjsonRowParser(COLS);
    const rows = p.push('["A", 1, null, null]\n["B", 2, null, null]\n["C", 3, null, null]\n');
    expect(rows).toHaveLength(3);
  });
});

describe("normalizeColumns", () => {
  it("keeps valid columns, defaults unknown types to text", () => {
    expect(
      normalizeColumns([
        { name: "Name", type: "text" },
        { name: "Score", type: "NUMBER" },
        { name: "Notes", type: "paragraph" },
      ]),
    ).toEqual([
      { name: "Name", type: "text" },
      { name: "Score", type: "number" },
      { name: "Notes", type: "text" },
    ]);
  });

  it("drops unnamed / duplicate columns and non-arrays", () => {
    expect(normalizeColumns("nope")).toEqual([]);
    expect(
      normalizeColumns([
        { name: "  ", type: "text" },
        { name: "Name" },
        { name: "name", type: "url" }, // dup (case-insensitive)
        null,
      ]),
    ).toEqual([{ name: "Name", type: "text" }]);
  });
});

describe("normalizeRows", () => {
  it("aligns rows to columns and skips non-array entries", () => {
    expect(
      normalizeRows([["A", "5"], "junk", ["B", 2, "x", "y", "z"], null], COLS),
    ).toEqual([
      ["A", 5, null, null],
      ["B", 2, "x", "y"],
    ]);
  });
});

describe("serializeSheetForPrompt", () => {
  const content = {
    columns: COLS,
    rows: Array.from({ length: 100 }, (_, i) => [
      `Row ${i}`,
      i,
      "2024-01-01",
      "https://example.com/page",
    ]),
  };

  it("returns the full sheet untruncated when it fits", () => {
    const out = serializeSheetForPrompt(content, 1_000_000);
    expect(out.truncated).toBe(false);
    expect(out.shownRows).toBe(100);
    expect(JSON.parse(out.json).rows).toHaveLength(100);
  });

  it("halves rows until under budget and reports truncation", () => {
    const out = serializeSheetForPrompt(content, 2_000);
    expect(out.truncated).toBe(true);
    expect(out.shownRows).toBeLessThan(100);
    expect(out.json.length).toBeLessThanOrEqual(2_000);
    const parsed = JSON.parse(out.json) as { rows: unknown[] };
    expect(parsed.rows).toHaveLength(out.shownRows);
  });
});
