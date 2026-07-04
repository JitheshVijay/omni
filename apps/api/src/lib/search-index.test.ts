import { describe, expect, it } from "vitest";
import {
  contentHash,
  extractArtifactText,
  hrefFor,
  makeSnippet,
  scoreFromDistance,
} from "./search-index.js";

describe("contentHash", () => {
  it("is stable for identical inputs and differs when text changes", () => {
    const a = contentHash("Title", "body text");
    const b = contentHash("Title", "body text");
    const c = contentHash("Title", "different body");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("separates the title from the snippet (no boundary collision)", () => {
    // "ab" + "\n" + "c"  must differ from  "a" + "\n" + "bc".
    expect(contentHash("ab", "c")).not.toBe(contentHash("a", "bc"));
  });
});

describe("makeSnippet", () => {
  it("collapses whitespace", () => {
    expect(makeSnippet("hello   world\n\tfoo")).toBe("hello world foo");
  });

  it("trims and clips long text with an ellipsis", () => {
    const out = makeSnippet("x".repeat(500), 10);
    expect(out.length).toBe(10);
    expect(out.endsWith("…")).toBe(true);
  });

  it("leaves short text untouched (no ellipsis)", () => {
    expect(makeSnippet("short", 100)).toBe("short");
  });

  it("handles empty / nullish input", () => {
    expect(makeSnippet("")).toBe("");
    expect(makeSnippet(undefined as unknown as string)).toBe("");
  });
});

describe("scoreFromDistance", () => {
  it("maps cosine distance to similarity (higher = closer)", () => {
    expect(scoreFromDistance(0)).toBe(1);
    expect(scoreFromDistance(1)).toBe(0);
    expect(scoreFromDistance(0.25)).toBeCloseTo(0.75);
  });
});

describe("hrefFor", () => {
  it("routes drive files to the drive page", () => {
    expect(hrefFor({ kind: "drive", ref_id: "f1" })).toBe("/drive");
  });

  it("routes threads to their chat page", () => {
    expect(hrefFor({ kind: "thread", ref_id: "t1" })).toBe("/chat/t1");
  });

  it("routes hub chunks to their hub (or the hub list when unknown)", () => {
    expect(hrefFor({ kind: "hub_chunk", ref_id: "c1", hubId: "h1" })).toBe(
      "/hubs/h1",
    );
    expect(hrefFor({ kind: "hub_chunk", ref_id: "c1" })).toBe("/hubs");
  });

  it("routes artifacts to their kind-specific editor", () => {
    expect(hrefFor({ kind: "artifact", ref_id: "a1", artifactKind: "doc" })).toBe(
      "/tools/docs/a1",
    );
    expect(
      hrefFor({ kind: "artifact", ref_id: "a1", artifactKind: "slides" }),
    ).toBe("/tools/slides/a1");
    expect(
      hrefFor({ kind: "artifact", ref_id: "a1", artifactKind: "sheet" }),
    ).toBe("/tools/sheets/a1");
    expect(
      hrefFor({ kind: "artifact", ref_id: "a1", artifactKind: "image" }),
    ).toBe("/tools/images");
    expect(
      hrefFor({ kind: "artifact", ref_id: "a1", artifactKind: "audio" }),
    ).toBe("/tools/podcast");
  });

  it("falls back to the library for unknown artifact kinds", () => {
    expect(
      hrefFor({ kind: "artifact", ref_id: "a1", artifactKind: "webpage" }),
    ).toBe("/library");
    expect(hrefFor({ kind: "artifact", ref_id: "a1" })).toBe("/library");
  });
});

describe("extractArtifactText", () => {
  it("returns empty for null / malformed content", () => {
    expect(extractArtifactText(null)).toBe("");
    expect(extractArtifactText("not json")).toBe("");
  });

  it("pulls markdown from a doc artifact", () => {
    const content = JSON.stringify({ markdown: "# Hello\n\nworld", blocks: null });
    expect(extractArtifactText(content)).toContain("Hello");
    expect(extractArtifactText(content)).toContain("world");
  });

  it("flattens nested slide/sheet structures", () => {
    const content = JSON.stringify({
      slides: [
        { title: "Intro", bullets: ["alpha", "beta"] },
        { title: "Outro", body: ["gamma"] },
      ],
    });
    const text = extractArtifactText(content);
    for (const token of ["Intro", "alpha", "beta", "Outro", "gamma"]) {
      expect(text).toContain(token);
    }
  });

  it("collapses whitespace in the flattened output", () => {
    const content = JSON.stringify({ a: "one   two", b: "three" });
    expect(extractArtifactText(content)).toBe("one two three");
  });
});
