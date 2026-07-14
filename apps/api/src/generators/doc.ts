// Doc generator: prompt (+ optional hub memory grounding) -> streamed
// GitHub-flavored Markdown -> artifact row (kind 'doc').
//
// Content shape stored in artifacts.content:
//   { markdown, blocks: null, sources: [{idx,label,file_id,snippet}] }
// blocks stays null until the BlockNote editor first saves; markdown is
// ALWAYS kept in sync — it is the export + TTS source. Hub-grounded docs
// cite borrowed facts inline with [[cite:IDX:LABEL]] tokens the editor
// renders as citation pills.
import { z } from "zod";
import {
  LLM_REQUEST_OPTS,
  MODELS,
  embedText,
  fromJson,
  openai,
  providerRoutingForCache,
  wrapSystemForCache,
} from "@omni/sdk";
import { searchHubMemory } from "../lib/hub-memory.js";
import {
  getArtifact,
  insertArtifact,
  toArtifactSummary,
  type ArtifactSummary,
  type GenCtx,
  type GeneratorService,
} from "./types.js";

// ─── Document types ─────────────────────────────────────────────────
// Each type steers STRUCTURE (sections, tables, checklists, Q&A, ...) so the
// output is a genuine document of that kind, not a generic essay. "auto" lets
// the model infer the best structure from the request.
const DOC_TYPES = {
  auto: {
    label: "Auto",
    guidance:
      "Infer the most fitting document type from the request and structure it with that type's conventions (report, step-by-step guide, spec, meeting notes, proposal, article, letter, FAQ, checklist, comparison, study notes, ...). Choose the structure that best serves the content rather than defaulting to a flat essay.",
  },
  report: {
    label: "Report",
    guidance:
      "Write a REPORT: after the H1, open with a brief **Executive summary**, then themed sections under H2 headings, put comparative or quantitative data in Markdown tables, and close with **Findings** and **Recommendations / Next steps**. Objective and information-dense.",
  },
  how_to: {
    label: "How-to guide",
    guidance:
      "Write a STEP-BY-STEP GUIDE: a one-line statement of the outcome, a **Prerequisites** list, then clear numbered steps (H2 per step or an ordered list) with the exact actions; call out tips and warnings as blockquotes; end with a short **Result / Verification** section.",
  },
  prd: {
    label: "Product spec (PRD)",
    guidance:
      "Write a PRD: sections for **Problem**, **Goals / Non-goals**, **Users & jobs-to-be-done**, **Requirements** (a table of requirement + priority, plus edge cases), **Rollout plan**, and **Success metrics**. Precise and testable, not marketing prose.",
  },
  meeting_notes: {
    label: "Meeting notes",
    guidance:
      "Write MEETING NOTES: a header (date, attendees, purpose), a time-boxed **Agenda** list, **Discussion** bullets per topic, a **Decisions** list, and an **Action items** TABLE (Owner | Task | Due). Scannable, not prose.",
  },
  proposal: {
    label: "Proposal",
    guidance:
      "Write a PROPOSAL: **Overview**, **Objectives**, **Scope & deliverables** (bulleted), a **Timeline** with milestones (table), an **Investment / Pricing** table, **Terms**, and a clear **Next steps** call to action. Persuasive but concrete.",
  },
  blog_post: {
    label: "Article / blog post",
    guidance:
      "Write an ARTICLE: a compelling title, a hook opening on why this matters, subheaded sections (H2/H3) with concrete examples and the occasional list, and a conclusion with a takeaway or call to action. Engaging, conversational, skimmable.",
  },
  letter: {
    label: "Letter / email",
    guidance:
      "Write a LETTER/EMAIL: after the H1 document title, write it as correspondence — an optional date line, a salutation (Dear …,), well-structured body paragraphs that make the ask or point, and a sign-off. Match tone to the audience; no headings inside the body.",
  },
  faq: {
    label: "FAQ",
    guidance:
      "Write an FAQ: a one-line intro, then a series of questions each as an H3 (`### Question?`) followed by a concise, self-contained answer. Order from most to least common. No filler.",
  },
  checklist: {
    label: "Checklist / SOP",
    guidance:
      "Write a CHECKLIST / standard operating procedure: a short **Purpose** line, then actionable items as GitHub-style checkboxes (`- [ ] do X`), grouped under phase headings where useful. Each item is a concrete, verifiable action.",
  },
  comparison: {
    label: "Comparison",
    guidance:
      "Write a COMPARISON: a one-paragraph framing, a central Markdown TABLE comparing the options across the criteria that matter, short pros/cons per option, and a **Recommendation** stating which to pick and when.",
  },
  study_notes: {
    label: "Study notes",
    guidance:
      "Write STUDY NOTES: organized by topic under H2/H3 headings, **key terms in bold** with crisp definitions, bulleted explanations, worked examples where relevant, and a **Key takeaways** summary list at the end. Optimized for review and recall.",
  },
  resume: {
    label: "Resume / CV",
    guidance:
      "Write a RESUME/CV (ATS-friendly): the name as the H1, then a role + contact line; a 2-3 sentence **Professional summary**; a **Skills** section (grouped); **Experience** in reverse-chronological order (each role: **Title**, Company — Location, dates; then 3-5 achievement bullets that lead with a strong verb and quantify impact with metrics); **Education**; and optional **Certifications / Projects**. No first-person pronouns; concise and results-driven.",
  },
  release_notes: {
    label: "Release notes",
    guidance:
      "Write RELEASE NOTES: an H1 with product + version and the release date, a one-line summary, then user-facing sections labelled **✨ New features**, **🚀 Improvements**, **🐛 Bug fixes**, and **⚠️ Breaking changes / Deprecations** (omit any that don't apply). Each item is a short bullet describing the user-visible change, not the code. End with any upgrade notes.",
  },
  case_study: {
    label: "Case study",
    guidance:
      "Write a CASE STUDY (customer success story, the way Genspark structures them): an **Overview** (client, industry, one-line result), **Challenge** (problem and stakes), **Solution** (what was done and why), and **Results** with quantified outcomes presented as metric tiles — a compact table such as | Metric | Before | After | or bold stat callouts. Include a realistic **customer quote** as a blockquote, and close with a short **Conclusion / call to action**.",
  },
  one_pager: {
    label: "One-pager",
    guidance:
      "Write a ONE-PAGER: a bold headline + one-line tagline, then tight, scannable sections — **Problem**, **Solution**, **Key features / benefits** (bullets), **Traction / metrics** (a short stat row or table), **Market / opportunity**, **Team** (if relevant), and a clear **Ask / next step**. Dense and confident; everything fits on a single page.",
  },
  press_release: {
    label: "Press release",
    guidance:
      "Write a PRESS RELEASE in standard AP style: start with **FOR IMMEDIATE RELEASE**, then the H1 headline and an italic subheadline; open the lead paragraph with a dateline (CITY, State — Month Day, Year —) answering who/what/when/where/why; 2-3 body paragraphs including at least one **quote** from a named spokesperson (blockquote); a **Boilerplate** 'About [Company]' paragraph; a media **Contact** block; and end with a centered '###' to mark the close.",
  },
  essay: {
    label: "Essay / prose",
    guidance:
      "Write flowing PROSE: a clear thesis, well-developed paragraphs under light headings, and a conclusion. Keep lists minimal — carry the argument in the writing.",
  },
} as const;

export type DocType = keyof typeof DOC_TYPES;
const DOC_TYPE_KEYS = Object.keys(DOC_TYPES) as [DocType, ...DocType[]];

// ─── Input ──────────────────────────────────────────────────────────

const DocInputSchema = z.object({
  prompt: z.string().min(1).max(8000),
  title: z.string().max(200).optional(),
  hub_id: z.string().nullable().optional(),
  length: z.enum(["short", "medium", "long"]).default("medium"),
  // Document type steers the structure (report, guide, PRD, letter, FAQ, ...).
  doc_type: z.enum(DOC_TYPE_KEYS).default("auto"),
  // Override mainly for tests; defaults to the registry default.
  model: z.string().optional(),
});

export type DocInput = z.infer<typeof DocInputSchema>;

export interface DocSource {
  idx: number;
  label: string;
  file_id: string | null;
  snippet: string;
}

export interface DocContent {
  markdown: string;
  blocks?: unknown[] | null;
  sources: DocSource[];
}

// ─── Pure helpers (exported for tests) ──────────────────────────────

/**
 * Inline citation token: [[cite:IDX:LABEL]] where IDX is the 1-based
 * source number and LABEL its cite_label. Capture groups: (idx, label).
 * Global — use with matchAll or reset lastIndex between uses.
 */
export const CITE_TOKEN_RE = /\[\[cite:(\d+):([^\]]+)\]\]/g;

/** First H1 line of a markdown document, or null when there isn't one. */
export function extractTitle(markdown: string): string | null {
  for (const line of markdown.split("\n")) {
    const m = /^#\s+(.+)$/.exec(line.trim());
    if (m) {
      const title = m[1].replace(/\s*#+\s*$/, "").trim();
      if (title) return title;
    }
  }
  return null;
}

/** Fallback title when the model didn't emit an H1: the prompt, clipped. */
export function titleFromPrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

// ─── Prompt assembly ────────────────────────────────────────────────

const LENGTH_GUIDANCE: Record<DocInput["length"], { words: number; maxTokens: number }> = {
  short: { words: 400, maxTokens: 1500 },
  medium: { words: 1000, maxTokens: 3000 },
  long: { words: 2000, maxTokens: 6000 },
};

function buildSystemPrompt(
  length: DocInput["length"],
  hasSources: boolean,
  docType: DocType,
): string {
  const parts = [
    "You are an expert document writer. Write the requested document as GitHub-flavored Markdown.",
    [
      "Rules:",
      "- Output ONLY the document itself — no preamble, no commentary, and no code fence wrapping the whole document.",
      "- Start with a single H1 title line (`# Title`).",
      `- Target length: about ${LENGTH_GUIDANCE[length].words} words.`,
      "- Use headings, lists, and tables where they genuinely help; tight prose, no filler.",
    ].join("\n"),
    // Type-specific structure: this is what makes a report a report and a
    // checklist a checklist rather than a generic essay.
    DOC_TYPES[docType].guidance,
  ];
  if (hasSources) {
    parts.push(
      [
        "Numbered source excerpts from the user's hub are provided. Ground the document in them.",
        "REQUIRED: cite every borrowed fact inline with the EXACT token format [[cite:IDX:LABEL]] where IDX is the source number and LABEL is that source's label — e.g. [[cite:2:Page 3]].",
        "Place the token immediately after the fact it supports. Never invent sources or cite ones you did not use.",
      ].join("\n"),
    );
  }
  return parts.join("\n\n");
}

function buildSourcesBlock(
  sources: DocSource[],
  hits: Array<{ chunk_text: string; file_name?: string | null }>,
): string {
  const parts = ["Source excerpts, numbered for citation:"];
  let budget = 14_000;
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fileName = hits[i]?.file_name ? ` — ${hits[i].file_name}` : "";
    const entry = `[${s.idx}] ${s.label}${fileName}:\n${(hits[i]?.chunk_text ?? s.snippet).slice(0, 1500)}`;
    if (entry.length > budget) break;
    budget -= entry.length;
    parts.push(entry);
  }
  return parts.join("\n\n---\n\n");
}

// ─── Streaming ──────────────────────────────────────────────────────

// Structural stream-chunk shape (OpenRouter's OpenAI-compatible SSE chunks).
interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

type OaiMessage = { role: "system" | "user" | "assistant"; content: unknown };

// The OpenAI SDK's create() overloads fight structural message arrays under
// strict TS; bind a loosely-typed alias once and keep the loosening local.
const createChatStream = openai.chat.completions.create.bind(
  openai.chat.completions,
) as unknown as (
  body: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<AsyncIterable<StreamChunk>>;

/** Stream a markdown completion, forwarding chunks as delta events. */
async function streamMarkdown(opts: {
  system: string;
  contextBlock?: string;
  prompt: string;
  model: string;
  maxTokens: number;
  ctx: GenCtx;
}): Promise<string> {
  const { ctx } = opts;
  const messages: OaiMessage[] = [
    { role: "system", content: wrapSystemForCache(opts.system, opts.model) },
  ];
  if (opts.contextBlock) messages.push({ role: "system", content: opts.contextBlock });
  messages.push({ role: "user", content: opts.prompt });

  ctx.emit({ type: "status", label: "Writing" });
  const stream = await createChatStream(
    {
      model: opts.model,
      messages,
      stream: true,
      max_tokens: opts.maxTokens,
      // CRITICAL: disable extended thinking. A reasoning-enabled Claude model
      // spends the whole (capped) max_tokens budget "thinking" and streams zero
      // content deltas, surfacing as "Model produced an empty document".
      reasoning: { enabled: false },
      ...providerRoutingForCache(opts.model),
    },
    { ...LLM_REQUEST_OPTS, signal: ctx.signal },
  );

  let markdown = "";
  for await (const chunk of stream) {
    if (ctx.signal.aborted) throw new Error("aborted");
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta.length > 0) {
      markdown += delta;
      ctx.emit({ type: "delta", channel: "markdown", data: delta });
    }
  }
  if (!markdown.trim()) throw new Error("Model produced an empty document");
  return markdown;
}

// ─── Generator ──────────────────────────────────────────────────────

async function runDoc(input: DocInput, ctx: GenCtx): Promise<ArtifactSummary> {
  const model = input.model ?? MODELS.default;

  // Hub grounding: embed the prompt, pull the top chunks, number them.
  let sources: DocSource[] = [];
  let contextBlock: string | undefined;
  if (input.hub_id) {
    ctx.emit({ type: "status", label: "Searching hub memory" });
    const embedding = await embedText(input.prompt);
    if (embedding) {
      const hits = searchHubMemory(input.hub_id, embedding, 12);
      if (hits.length > 0) {
        sources = hits.map((h, i) => ({
          idx: i + 1,
          label: h.cite_label,
          file_id: h.file_id,
          snippet: h.chunk_text.slice(0, 240),
        }));
        contextBlock = buildSourcesBlock(sources, hits);
      }
    }
  }

  const markdown = await streamMarkdown({
    system: buildSystemPrompt(input.length, sources.length > 0, input.doc_type),
    contextBlock,
    prompt: input.prompt,
    model,
    maxTokens: LENGTH_GUIDANCE[input.length].maxTokens,
    ctx,
  });

  const title = input.title?.trim() || extractTitle(markdown) || titleFromPrompt(input.prompt);
  const content: DocContent = { markdown, blocks: null, sources };
  const row = insertArtifact({
    userId: ctx.userId,
    kind: "doc",
    title,
    content,
    hubId: input.hub_id ?? null,
  });
  return toArtifactSummary(row);
}

async function reviseDoc(
  artifactId: string,
  instruction: string,
  ctx: GenCtx,
): Promise<ArtifactSummary> {
  const parent = getArtifact(artifactId, ctx.userId);
  if (!parent) throw new Error("Artifact not found");
  if (parent.kind !== "doc") throw new Error("Not a doc artifact");
  const parentContent = fromJson<DocContent>(parent.content);
  const currentMarkdown = parentContent?.markdown?.trim();
  if (!currentMarkdown) throw new Error("Document has no markdown to revise");
  const sources = parentContent?.sources ?? [];

  const system = [
    "You are an expert document editor working in GitHub-flavored Markdown.",
    [
      "Rules:",
      "- Output ONLY the revised document — no preamble, no commentary, no code fence wrapping the whole document.",
      "- Start with a single H1 title line (`# Title`).",
      "- Preserve existing [[cite:IDX:LABEL]] citation tokens wherever the cited fact survives the revision. Never invent new citations.",
    ].join("\n"),
  ].join("\n\n");

  const prompt = [
    "Revise the following markdown document per the instruction. Output the FULL revised document as markdown only.",
    `Instruction: ${instruction}`,
    "Current document:",
    currentMarkdown,
  ].join("\n\n");

  const markdown = await streamMarkdown({
    system,
    prompt,
    model: MODELS.default,
    maxTokens: LENGTH_GUIDANCE.long.maxTokens,
    ctx,
  });

  const content: DocContent = { markdown, blocks: null, sources };
  const row = insertArtifact({
    userId: ctx.userId,
    kind: "doc",
    title: extractTitle(markdown) ?? parent.title,
    content,
    hubId: parent.hub_id,
    parentId: parent.id,
  });
  return toArtifactSummary(row);
}

export const docGenerator: GeneratorService<DocInput> = {
  name: "doc",
  inputSchema: DocInputSchema,
  toolDescription:
    "Write a document from a prompt as rich markdown. Set doc_type to shape the structure: report, how_to (step-by-step guide), prd (product spec), meeting_notes, proposal, blog_post, letter (letter/email), faq, checklist (checklist/SOP), comparison, study_notes, resume (resume/CV), release_notes, case_study, one_pager, press_release, essay, or auto to infer. Optionally grounded in a hub's files with inline citations.",
  run: runDoc,
  revise: reviseDoc,
};
