import { describe, it, expect } from "vitest";
import { stripMarkdown } from "./markdown-strip.js";

describe("stripMarkdown", () => {
  it("removes fenced code blocks entirely", () => {
    const md = "Before.\n\n```ts\nconst x = 1;\nconsole.log(x);\n```\n\nAfter.";
    const out = stripMarkdown(md);
    expect(out).toContain("Before.");
    expect(out).toContain("After.");
    expect(out).not.toContain("const x");
    expect(out).not.toContain("```");
  });

  it("turns links into their visible text and drops images", () => {
    const md = "See [the docs](https://example.com/docs) and ![a chart](https://example.com/c.png) here.";
    const out = stripMarkdown(md);
    expect(out).toContain("the docs");
    expect(out).not.toContain("https://example.com");
    expect(out).not.toContain("a chart");
    expect(out).not.toContain("![");
  });

  it("removes [[cite:IDX:LABEL]] tokens", () => {
    const md = "Solar output doubled in 2024 [[cite:1:Page 3]] and kept rising [[cite:12:report.pdf p2]].";
    const out = stripMarkdown(md);
    expect(out).not.toContain("[[cite:");
    expect(out).toContain("Solar output doubled in 2024");
    expect(out).toContain("kept rising");
  });

  it("strips heading, list, blockquote, and emphasis markers", () => {
    const md = [
      "# Title",
      "",
      "> A quote",
      "",
      "- item one",
      "2. item two",
      "",
      "Some **bold** and _italic_ text with `inline code`.",
    ].join("\n");
    const out = stripMarkdown(md);
    expect(out).toContain("Title");
    expect(out).toContain("A quote");
    expect(out).toContain("item one");
    expect(out).toContain("item two");
    expect(out).toContain("Some bold and italic text with inline code.");
    expect(out).not.toMatch(/[#>*_`]/);
  });

  it("collapses whitespace and trims", () => {
    const md = "# H\n\n\n\n\nParagraph   with    gaps.\n\n\n";
    const out = stripMarkdown(md);
    expect(out).toBe("H\n\nParagraph with gaps.");
  });
});
