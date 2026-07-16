// Document design system: turns a generated doc's Markdown + a chosen theme
// into a self-contained, print-quality HTML document (cover, themed typography,
// styled tables / callouts / checklists, A4 print CSS). This is the "design
// infrastructure" for docs — the same idea as the deck Theme registry, adapted
// for long-form documents on light paper. Fully offline: system font stacks,
// no external assets, so the HTML prints and downloads cleanly.
import { marked } from "marked";
import type { DocSource } from "../generators/doc.js";

export interface DocTheme {
  id: string;
  name: string;
  accent: string; // headings rules, links, cover
  accentSoft: string; // table header + callout background tint
  ink: string; // body text
  muted: string; // secondary text
  rule: string; // hairline borders
  headingFont: string;
  bodyFont: string;
  headingWeight: number;
}

const SANS =
  "'Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF = "ui-serif, Georgia, Cambria, 'Times New Roman', Times, serif";

// Curated light-paper themes. Each maps well to a family of doc types.
export const DOC_THEMES: Record<string, DocTheme> = {
  modern: {
    id: "modern",
    name: "Modern",
    accent: "#4F46E5",
    accentSoft: "#EEF0FE",
    ink: "#1A1A24",
    muted: "#5B6072",
    rule: "#E4E6EF",
    headingFont: SANS,
    bodyFont: SANS,
    headingWeight: 700,
  },
  classic: {
    id: "classic",
    name: "Classic",
    accent: "#1E3A5F",
    accentSoft: "#EAF0F7",
    ink: "#1C232B",
    muted: "#5A6672",
    rule: "#E1E6EC",
    headingFont: SERIF,
    bodyFont: SERIF,
    headingWeight: 700,
  },
  editorial: {
    id: "editorial",
    name: "Editorial",
    accent: "#B4531F",
    accentSoft: "#FBEEE4",
    ink: "#241A14",
    muted: "#6E5A4C",
    rule: "#EFE3D8",
    headingFont: SERIF,
    bodyFont: SANS,
    headingWeight: 700,
  },
  technical: {
    id: "technical",
    name: "Technical",
    accent: "#0E7490",
    accentSoft: "#E2F3F7",
    ink: "#12232A",
    muted: "#516A72",
    rule: "#DCEAEE",
    headingFont: SANS,
    bodyFont: SANS,
    headingWeight: 700,
  },
  minimal: {
    id: "minimal",
    name: "Minimal",
    accent: "#111827",
    accentSoft: "#F1F2F4",
    ink: "#111827",
    muted: "#6B7280",
    rule: "#E5E7EB",
    headingFont: SANS,
    bodyFont: SANS,
    headingWeight: 650,
  },
  slate: {
    id: "slate",
    name: "Slate",
    accent: "#3F5166",
    accentSoft: "#EDF1F5",
    ink: "#1B242E",
    muted: "#5C6B7A",
    rule: "#E1E7ED",
    headingFont: SANS,
    bodyFont: SERIF,
    headingWeight: 700,
  },
};

export const DEFAULT_DOC_THEME = "modern";

// A sensible default theme per document type (used at generation time).
const TYPE_THEME: Record<string, string> = {
  report: "classic",
  proposal: "classic",
  letter: "classic",
  meeting_notes: "slate",
  prd: "technical",
  how_to: "technical",
  release_notes: "technical",
  faq: "technical",
  checklist: "technical",
  blog_post: "editorial",
  case_study: "editorial",
  study_notes: "editorial",
  comparison: "slate",
  resume: "minimal",
  one_pager: "minimal",
  essay: "classic",
};

export function themeForDocType(docType: string | undefined): string {
  return (docType && TYPE_THEME[docType]) || DEFAULT_DOC_THEME;
}

export function resolveDocTheme(id: string | undefined): DocTheme {
  return DOC_THEMES[id ?? ""] ?? DOC_THEMES[DEFAULT_DOC_THEME];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Pull the leading H1 out of the markdown so it becomes the cover title and
// isn't repeated in the body.
function stripLeadingH1(md: string): { title: string | null; body: string } {
  const lines = md.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const m = /^#\s+(.+)$/.exec(t);
    if (m) {
      lines.splice(i, 1);
      return { title: m[1].replace(/\s*#+\s*$/, "").trim(), body: lines.join("\n") };
    }
    break;
  }
  return { title: null, body: md };
}

// Inline [[cite:N:label]] tokens -> a small superscript marker.
function transformCitations(md: string): string {
  return md.replace(
    /\[\[cite:(\d+):([^\]]+)\]\]/g,
    (_m, n: string, label: string) => `<sup class="cite" title="${escapeHtml(label)}">${n}</sup>`,
  );
}

function stylesheet(t: DocTheme): string {
  return `
:root { color-scheme: light; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #f2f3f5; }
body {
  font-family: ${t.bodyFont};
  color: ${t.ink};
  font-size: 16px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}
.page {
  max-width: 780px;
  margin: 32px auto;
  background: #fff;
  padding: 56px 64px 72px;
  box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 10px 40px rgba(0,0,0,.06);
  border-radius: 4px;
}
.cover { margin-bottom: 36px; }
.cover .eyebrow {
  font-family: ${t.headingFont};
  text-transform: uppercase;
  letter-spacing: .12em;
  font-size: 11px;
  font-weight: 600;
  color: ${t.accent};
  margin: 0 0 10px;
}
.cover h1 {
  font-family: ${t.headingFont};
  font-weight: ${t.headingWeight};
  font-size: 34px;
  line-height: 1.15;
  letter-spacing: -0.01em;
  margin: 0 0 14px;
  color: ${t.ink};
}
.cover .rule { height: 3px; width: 64px; background: ${t.accent}; border: 0; border-radius: 2px; margin: 0; }
.doc h1, .doc h2, .doc h3, .doc h4 { font-family: ${t.headingFont}; color: ${t.ink}; line-height: 1.25; }
.doc h2 {
  font-size: 22px; font-weight: ${t.headingWeight}; margin: 34px 0 12px;
  padding-bottom: 6px; border-bottom: 1px solid ${t.rule};
}
.doc h3 { font-size: 17px; font-weight: 650; margin: 24px 0 8px; }
.doc h4 { font-size: 15px; font-weight: 650; margin: 20px 0 6px; color: ${t.muted}; }
.doc p { margin: 0 0 14px; }
.doc a { color: ${t.accent}; text-decoration: underline; text-underline-offset: 2px; }
.doc strong { color: ${t.ink}; }
.doc ul, .doc ol { margin: 0 0 14px; padding-left: 22px; }
.doc li { margin: 4px 0; }
.doc ul.contains-task-list, .doc li.task-list-item { list-style: none; }
.doc li.task-list-item { padding-left: 2px; }
.doc li.task-list-item input { margin: 0 8px 0 -20px; accent-color: ${t.accent}; }
.doc blockquote {
  margin: 16px 0; padding: 10px 16px;
  border-left: 3px solid ${t.accent}; background: ${t.accentSoft};
  color: ${t.ink}; border-radius: 0 4px 4px 0;
}
.doc blockquote p:last-child { margin-bottom: 0; }
.doc table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 14.5px; }
.doc th, .doc td { text-align: left; padding: 8px 12px; border: 1px solid ${t.rule}; vertical-align: top; }
.doc th { background: ${t.accentSoft}; color: ${t.accent}; font-family: ${t.headingFont}; font-weight: 650; }
.doc code {
  font-family: ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
  font-size: 0.88em; background: ${t.accentSoft}; padding: 1px 5px; border-radius: 4px;
}
.doc pre {
  background: #0e1116; color: #e6edf3; padding: 14px 16px; border-radius: 8px;
  overflow-x: auto; margin: 16px 0; font-size: 13px; line-height: 1.5;
}
.doc pre code { background: none; padding: 0; color: inherit; }
.doc hr { border: 0; border-top: 1px solid ${t.rule}; margin: 28px 0; }
.doc img { max-width: 100%; border-radius: 6px; }
.doc sup.cite { color: ${t.accent}; font-weight: 600; font-size: 0.7em; cursor: help; }
.sources { margin-top: 40px; padding-top: 16px; border-top: 1px solid ${t.rule}; }
.sources h2 {
  font-family: ${t.headingFont}; font-size: 13px; text-transform: uppercase;
  letter-spacing: .1em; color: ${t.muted}; margin: 0 0 10px;
}
.sources ol { margin: 0; padding-left: 20px; color: ${t.muted}; font-size: 13.5px; }
.sources li { margin: 4px 0; }

@page { size: A4; margin: 18mm 16mm; }
@media print {
  html, body { background: #fff; }
  .page { box-shadow: none; margin: 0; max-width: none; padding: 0; border-radius: 0; }
  .doc h2, .doc h3, .doc h4 { page-break-after: avoid; }
  .doc table, .doc pre, .doc blockquote, .doc img { page-break-inside: avoid; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
`;
}

/** Render a doc's markdown into a self-contained, themed, print-ready HTML page. */
export function renderDesignedDoc(opts: {
  title: string;
  markdown: string;
  sources?: DocSource[];
  themeId?: string;
  eyebrow?: string;
}): string {
  const theme = resolveDocTheme(opts.themeId);
  const { title: h1, body } = stripLeadingH1(opts.markdown);
  const title = (opts.title || h1 || "Document").trim();

  const bodyHtml = marked.parse(transformCitations(body), { gfm: true, breaks: false }) as string;

  const sources = opts.sources ?? [];
  const sourcesHtml =
    sources.length > 0
      ? `<section class="sources"><h2>Sources</h2><ol>${sources
          .map(
            (s) =>
              `<li>${escapeHtml(s.label)}${s.snippet ? `: ${escapeHtml(s.snippet)}` : ""}</li>`,
          )
          .join("")}</ol></section>`
      : "";

  const eyebrow = opts.eyebrow ? `<p class="eyebrow">${escapeHtml(opts.eyebrow)}</p>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>${stylesheet(theme)}</style>
</head>
<body>
<div class="page">
<header class="cover">${eyebrow}<h1>${escapeHtml(title)}</h1><hr class="rule" /></header>
<article class="doc">${bodyHtml}</article>
${sourcesHtml}
</div>
</body>
</html>`;
}
