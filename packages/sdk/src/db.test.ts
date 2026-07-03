// Unit tests for the db helpers + embedding math.
//
// IMPORTANT: db.ts resolves DATA_DIR and opens the SQLite file at import
// time, so OMNI_DATA_DIR (and the env vars env-config requires) must be
// set BEFORE the module loads. Static imports hoist above any statement,
// so db.ts / embed.ts are loaded with dynamic import() after the env
// setup below.

import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const tempDataDir = mkdtempSync(path.join(tmpdir(), "omni-db-test-"));
process.env.OMNI_DATA_DIR = tempDataDir;
process.env.OPENROUTER_API_KEY ??= "test-key-not-used";
process.env.NODE_ENV ??= "test";

const {
  DATA_DIR,
  db,
  uuid,
  nowISO,
  toJson,
  fromJson,
  float32ToBuffer,
  bufferToFloat32,
} = await import("./db.js");
const { cosine } = await import("./ai/embed.js");

describe("data dir + database bootstrap", () => {
  it("resolves DATA_DIR from OMNI_DATA_DIR and creates blob subdirs", () => {
    expect(DATA_DIR).toBe(tempDataDir);
    for (const sub of ["drive", "artifacts", "runs"]) {
      expect(existsSync(path.join(tempDataDir, sub))).toBe(true);
    }
    expect(existsSync(path.join(tempDataDir, "omni.db"))).toBe(true);
  });

  it("opens the db in WAL mode with foreign keys on", () => {
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});

describe("uuid / nowISO", () => {
  it("uuid() returns unique v4-shaped uuids", () => {
    const a = uuid();
    const b = uuid();
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(a).not.toBe(b);
  });

  it("nowISO() returns a parseable ISO-8601 UTC timestamp", () => {
    const ts = nowISO();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(ts))).toBe(false);
  });
});

describe("toJson / fromJson", () => {
  it("round-trips objects", () => {
    const value = { a: 1, b: ["x", "y"], c: { nested: true }, d: null };
    const s = toJson(value);
    expect(typeof s).toBe("string");
    expect(fromJson<typeof value>(s)).toEqual(value);
  });

  it("maps null/undefined to SQL NULL", () => {
    expect(toJson(null)).toBeNull();
    expect(toJson(undefined)).toBeNull();
  });

  it("fromJson never throws on bad input", () => {
    expect(fromJson(null)).toBeNull();
    expect(fromJson(undefined)).toBeNull();
    expect(fromJson("")).toBeNull();
    expect(fromJson("{not json")).toBeNull();
  });
});

describe("float32 <-> Buffer round-trip", () => {
  it("round-trips exact float32 values", () => {
    // Values exactly representable in float32 so the round-trip is exact.
    const vec = [0.25, -1.5, 3.75, 0, 1024];
    const buf = float32ToBuffer(vec);
    expect(buf.byteLength).toBe(vec.length * 4);
    const back = bufferToFloat32(buf);
    expect(Array.from(back)).toEqual(vec);
  });

  it("round-trips arbitrary values within float32 precision", () => {
    const vec = Array.from({ length: 1536 }, (_, i) => Math.sin(i) * 0.1);
    const back = bufferToFloat32(float32ToBuffer(vec));
    expect(back.length).toBe(1536);
    for (let i = 0; i < vec.length; i += 128) {
      expect(back[i]).toBeCloseTo(vec[i], 6);
    }
  });

  it("accepts Float32Array input and survives unaligned buffers", () => {
    const f32 = Float32Array.from([1.5, -2.5]);
    const buf = float32ToBuffer(f32);
    // Simulate an unaligned pooled Buffer: place the bytes at offset 1 of
    // a fresh backing buffer (byteOffset 1 is never 4-aligned, so a naive
    // `new Float32Array(view.buffer, view.byteOffset, ...)` would throw).
    const backing = new Uint8Array(buf.byteLength + 1);
    backing.set(buf, 1);
    const unaligned = backing.subarray(1);
    expect(unaligned.byteOffset % 4).not.toBe(0);
    expect(Array.from(bufferToFloat32(unaligned))).toEqual([1.5, -2.5]);
  });
});

describe("cosine", () => {
  it("identical vectors -> 1", () => {
    expect(cosine([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it("orthogonal vectors -> 0", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });

  it("parallel vectors -> 1 regardless of magnitude", () => {
    expect(cosine([1, 2], [2, 4])).toBeCloseTo(1, 10);
  });

  it("opposite vectors -> -1", () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it("degenerate inputs -> 0 (never throws)", () => {
    expect(cosine([1, 2], [1, 2, 3])).toBe(0); // length mismatch
    expect(cosine([0, 0], [1, 2])).toBe(0); // zero vector
    expect(cosine([], [])).toBe(0); // empty
  });
});
