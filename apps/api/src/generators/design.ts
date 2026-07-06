// Design generator ("Design Studio"): prompt + format + palette -> ONE complete,
// fully self-contained HTML document that renders a SINGLE static, print-quality
// graphic design at an EXACT pixel size -> artifact row (kind 'webpage',
// meta.subtype 'design') with the html stored in content {html, format, width,
// height} AND written to a blob at artifacts/<id>.html.
//
// Unlike the webapp generator (which builds an interactive app), this produces a
// STATIC graphic — a poster / social post / flyer / cover / logo — whose <body>
// root is a single `<div id="design-canvas">` sized to EXACTLY width×height px.
// The client renders it in a scaled sandboxed iframe and exports it to PNG via
// html-to-image (reading #design-canvas from the same-origin iframe document).
//
// Reuses webapp.ts's design decisions verbatim: streamed token-by-token, fence
// stripped so the live preview never flashes "```html", reasoning DISABLED (a
// reasoning-enabled model burns its whole token budget "thinking" and emits an
// empty document), blob-first persist, one retry on an empty document.
//
// Content shape stored in artifacts.content: { html, format, width, height }
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  DATA_DIR,
  LLM_REQUEST_OPTS,
  MODELS,
  fromJson,
  openai,
  providerRoutingForCache,
  uuid,
  wrapSystemForCache,
} from "@omni/sdk";
import {
  getArtifact,
  insertArtifact,
  toArtifactSummary,
  type ArtifactSummary,
  type GenCtx,
  type GeneratorService,
} from "./types.js";

// ─── Format registry (must agree with apps/web/src/lib/design-formats.ts) ───

export interface DesignFormat {
  id: string;
  label: string;
  width: number;
  height: number;
  category: string;
}

// Literal-tuple of ids for the Zod enum (kept in sync with FORMATS below).
const FORMAT_IDS = [
  "instagram-post",
  "instagram-story",
  "twitter-header",
  "poster",
  "flyer",
  "presentation-cover",
  "ad-banner",
  "business-card",
  "logo",
  "document-cover",
] as const;

export const FORMATS: DesignFormat[] = [
  { id: "instagram-post", label: "Instagram Post", width: 1080, height: 1080, category: "Social" },
  { id: "instagram-story", label: "Instagram Story", width: 1080, height: 1920, category: "Social" },
  { id: "twitter-header", label: "Twitter / X Header", width: 1500, height: 500, category: "Social" },
  { id: "poster", label: "Poster", width: 1080, height: 1350, category: "Poster" },
  { id: "flyer", label: "Flyer (A4)", width: 1240, height: 1754, category: "Poster" },
  { id: "presentation-cover", label: "Presentation Cover", width: 1280, height: 720, category: "Marketing" },
  { id: "ad-banner", label: "Ad Banner", width: 1200, height: 628, category: "Marketing" },
  { id: "business-card", label: "Business Card", width: 1050, height: 600, category: "Personal" },
  { id: "logo", label: "Logo", width: 800, height: 800, category: "Branding" },
  { id: "document-cover", label: "Document Cover", width: 1240, height: 1754, category: "Document" },
];

export function getFormat(id: string): DesignFormat | undefined {
  return FORMATS.find((f) => f.id === id);
}

// What each format is FOR — folded into the system prompt so the model composes
// for the medium (a story is tall + thumb-stopping; a business card is a compact
// identity block; a logo is a single centered mark).
const FORMAT_PURPOSE: Record<string, string> = {
  "instagram-post": "a square Instagram feed post — a scroll-stopping social graphic with one punchy headline and a single clear focal point",
  "instagram-story": "a full-screen vertical Instagram/TikTok story — a bold top-to-bottom composition with the key message in the safe central band",
  "twitter-header": "a wide Twitter/X profile header banner — a panoramic strip; keep essential text roughly centered so profile-photo overlap on the left never covers it",
  "poster": "a promotional poster — a dramatic hero composition with a commanding title, supporting details, and strong vertical rhythm",
  "flyer": "a printable A4 flyer — a clear headline, a body of legible supporting information (what/when/where), and a call to action, laid out top to bottom",
  "presentation-cover": "a widescreen presentation title/cover slide — a confident title, a subtitle, and a tasteful decorative background",
  "ad-banner": "a horizontal display ad banner — a tight headline, a short value line, and an obvious call-to-action button/shape, readable at a glance",
  "business-card": "a business card front — a compact identity block: name, role, and contact lines with an elegant mark or monogram and refined spacing",
  "logo": "a single centered logo/brandmark on a clean field — a memorable symbol paired with a wordmark, balanced and scalable, with generous surrounding space",
  "document-cover": "a report/ebook/document cover — a strong title, subtitle, author/edition line, and a polished decorative treatment worthy of a printed cover",
};

// ─── Palettes / design systems ──────────────────────────────────────

const PALETTES = ["vibrant", "elegant", "minimal", "bold", "pastel", "dark-luxe"] as const;
export type DesignPalette = (typeof PALETTES)[number];

const PALETTE_GUIDANCE: Record<DesignPalette, string> = {
  vibrant:
    "Design system — VIBRANT: energetic, high-chroma color. Rich multi-stop gradients, saturated jewel and neon tones, bright contrasting accents, and a lively, modern feel. Let color carry the composition.",
  elegant:
    "Design system — ELEGANT: refined and sophisticated. A restrained, luxurious palette (deep navy/emerald/burgundy with cream and metallic gold accents), graceful high-contrast serif-style hierarchy via the system font, thin rules, and generous, calm spacing.",
  minimal:
    "Design system — MINIMAL: strict minimalism. Mostly monochrome with a single restrained accent, abundant negative space, hairline dividers, small refined typography, and a precise grid. Nothing decorative that isn't earning its place.",
  bold:
    "Design system — BOLD: loud and graphic. Massive display typography, heavy weights, blocky flat color fields, high contrast, confident asymmetry, and a poster/brutalist energy that grabs attention instantly.",
  pastel:
    "Design system — PASTEL: soft and airy. Gentle pastel tones (blush, mint, sky, lavender, butter), soft gradients, rounded shapes, plenty of light space, and a friendly, calming, contemporary mood.",
  "dark-luxe":
    "Design system — DARK LUXE: premium dark. A deep near-black or charcoal canvas, luminous gold/champagne/metallic accents, subtle glows and glassy layers, and understated, expensive-feeling contrast.",
};

// ─── Input ──────────────────────────────────────────────────────────

const DesignInputSchema = z.object({
  prompt: z.string().min(1).max(4000),
  format: z.enum(FORMAT_IDS).default("poster"),
  palette: z.enum(PALETTES).default("vibrant"),
  // Override mainly for tests; defaults to the registry default.
  model: z.string().optional(),
});

export type DesignInput = z.infer<typeof DesignInputSchema>;

export interface DesignContent {
  html: string;
  format: string;
  width: number;
  height: number;
}

// ─── Pure helpers ────────────────────────────────────────────────────

/** Fallback title when there's no <title>: the prompt, clipped. */
function titleFromPrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

/** The document's <title>, trimmed, or null when absent/empty. */
function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = m?.[1]?.replace(/\s+/g, " ").trim();
  return title ? title : null;
}

/**
 * Strip a markdown code fence the model may wrap the document in — replicated
 * from webapp.ts (kept local to avoid a circular import, since webapp.ts
 * delegates design revises here). `ended=false` (mid-stream) holds back an
 * as-yet-incomplete OPENING fence line by returning null so the live preview
 * never flashes "```html"; once resolved the result grows monotonically.
 */
function cleanFences(raw: string, ended: boolean): string | null {
  let s = raw.replace(/^\s+/, "");
  const open = /^```[^\n]*\n/.exec(s);
  if (open) {
    s = s.slice(open[0].length);
  } else if (/^```/.test(s) && !ended) {
    return null;
  }
  s = s.replace(/\n?```\s*$/, "");
  if (ended) {
    const start = /<!doctype html|<html[\s>]/i.exec(s);
    if (start && start.index > 0) s = s.slice(start.index);
    return s.trim();
  }
  return s;
}

// ─── Prompt assembly ────────────────────────────────────────────────

function buildSystemPrompt(format: DesignFormat, palette: DesignPalette): string {
  const { width, height } = format;
  return [
    `You are a world-class graphic designer. Produce ONE complete, self-contained HTML document that renders a SINGLE static graphic design at EXACTLY ${width}×${height} px.`,
    [
      "HARD RULES — follow every one:",
      `- The root of <body> is a single element \`<div id="design-canvas">\` sized to EXACTLY ${width}px wide by ${height}px tall. Position it so it fills that box precisely (position:absolute; top:0; left:0; width:${width}px; height:${height}px; margin:0; overflow:hidden) and there is NO page scroll. Reset the page with \`*{margin:0;padding:0;box-sizing:border-box}\` and give <html>/<body> zero margin.`,
      "- ALL styling lives in ONE inline <style> in the <head>; the document is fully self-contained.",
      "- ZERO network/CDN/font/image URLs: no external URLs, no CDNs, no <link>/@import stylesheets, no web fonts, no remote images, no fetch. It must render fully offline. Draw EVERY graphic with inline SVG, CSS gradients, CSS shapes, borders, and emoji.",
      "- Use ONLY the system font stack (e.g. `system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`) with a STRONG typographic hierarchy — dramatic size contrast between the headline and everything else, deliberate weight and letter-spacing.",
      "- This is a STATIC, print-quality graphic (a poster / social post / flyer / cover / logo) — NOT a web app or UI. No interactivity, no buttons, no forms; no JavaScript is required. Think bold composition, a clear focal hierarchy, intentional negative space, and generous, confident use of color and shape.",
      "- Fill the canvas EDGE TO EDGE: a deliberate background (gradient, color field, or SVG pattern), layered decorative shapes, and text sized and placed for real visual impact. Make it genuinely beautiful and finished, like a professional designer's export.",
      "- Include a meaningful <title>.",
      "- Output ONLY the HTML, from `<!doctype html>` through `</html>`. No prose before or after, and DO NOT wrap it in a markdown code fence.",
    ].join("\n"),
    `This design is ${FORMAT_PURPOSE[format.id] ?? "a graphic design"} — composed for a ${width}×${height}px ${format.label}.`,
    PALETTE_GUIDANCE[palette],
  ].join("\n\n");
}

// ─── Streaming ──────────────────────────────────────────────────────

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

type OaiMessage = { role: "system" | "user" | "assistant"; content: unknown };

// The OpenAI SDK's create() overloads fight structural message arrays under
// strict TS; bind a loosely-typed alias once (same pattern as webapp.ts).
const createChatStream = openai.chat.completions.create.bind(
  openai.chat.completions,
) as unknown as (
  body: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<AsyncIterable<StreamChunk>>;

const MAX_TOKENS = 12_000;

/** Thrown when the model returns no usable HTML — retried once by the caller. */
class EmptyDocumentError extends Error {
  constructor() {
    super("Model produced an empty design");
    this.name = "EmptyDocumentError";
  }
}

/** Stream an HTML completion, forwarding fence-stripped chunks as html deltas. */
async function streamHtml(opts: {
  system: string;
  prompt: string;
  model: string;
  ctx: GenCtx;
}): Promise<string> {
  const { ctx } = opts;
  const messages: OaiMessage[] = [
    { role: "system", content: wrapSystemForCache(opts.system, opts.model) },
    { role: "user", content: opts.prompt },
  ];

  const stream = await createChatStream(
    {
      model: opts.model,
      messages,
      stream: true,
      max_tokens: MAX_TOKENS,
      // CRITICAL: disable extended thinking. A reasoning-enabled Claude model
      // spends the ENTIRE token budget "thinking" about a complex design and
      // emits zero HTML (finish_reason "length", content ""). Composing markup
      // is a direct task; no thinking budget needed.
      reasoning: { enabled: false },
      ...providerRoutingForCache(opts.model),
    },
    { ...LLM_REQUEST_OPTS, signal: ctx.signal },
  );

  let raw = "";
  let emitted = 0;
  for await (const chunk of stream) {
    if (ctx.signal.aborted) throw new Error("aborted");
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta !== "string" || delta.length === 0) continue;
    raw += delta;
    const cleaned = cleanFences(raw, false);
    if (cleaned !== null && cleaned.length > emitted) {
      ctx.emit({ type: "delta", channel: "html", data: cleaned.slice(emitted) });
      emitted = cleaned.length;
    }
  }

  const html = cleanFences(raw, true) ?? "";
  if (!html.trim()) throw new EmptyDocumentError();
  return html;
}

/** streamHtml, retried once if the first attempt yields nothing. */
async function streamHtmlWithRetry(opts: {
  system: string;
  prompt: string;
  model: string;
  ctx: GenCtx;
}): Promise<string> {
  try {
    return await streamHtml(opts);
  } catch (err) {
    if (err instanceof EmptyDocumentError && !opts.ctx.signal.aborted) {
      opts.ctx.emit({ type: "status", label: "Retrying" });
      return await streamHtml(opts);
    }
    throw err;
  }
}

/** Blob-first (atomic .part -> rename) then row: a crash never leaves a row
 *  pointing at a missing blob. Returns the created artifact summary. */
async function persistDesign(opts: {
  html: string;
  title: string;
  format: DesignFormat;
  palette: DesignPalette;
  prompt: string;
  model: string;
  ctx: GenCtx;
  parentId?: string | null;
}): Promise<ArtifactSummary> {
  const id = uuid();
  const relPath = `artifacts/${id}.html`;
  const absPath = join(DATA_DIR, relPath);
  await writeFile(`${absPath}.part`, opts.html, "utf8");
  await rename(`${absPath}.part`, absPath);

  const content: DesignContent = {
    html: opts.html,
    format: opts.format.id,
    width: opts.format.width,
    height: opts.format.height,
  };
  const row = insertArtifact({
    id,
    userId: opts.ctx.userId,
    kind: "webpage",
    title: opts.title,
    content,
    relPath,
    parentId: opts.parentId ?? null,
    meta: {
      subtype: "design",
      prompt: opts.prompt,
      format: opts.format.id,
      palette: opts.palette,
      model: opts.model,
    },
  });
  return toArtifactSummary(row);
}

// ─── Generator ──────────────────────────────────────────────────────

async function runDesign(input: DesignInput, ctx: GenCtx): Promise<ArtifactSummary> {
  const format = getFormat(input.format);
  if (!format) throw new Error(`Unknown format: ${input.format}`);
  const model = input.model ?? MODELS.default;
  ctx.emit({ type: "status", label: "Designing" });

  const html = await streamHtmlWithRetry({
    system: buildSystemPrompt(format, input.palette),
    prompt: input.prompt,
    model,
    ctx,
  });
  if (ctx.signal.aborted) throw new Error("aborted");

  const title = extractTitle(html) ?? titleFromPrompt(input.prompt);
  return persistDesign({
    html,
    title,
    format,
    palette: input.palette,
    prompt: input.prompt,
    model,
    ctx,
  });
}

async function reviseDesign(
  artifactId: string,
  instruction: string,
  ctx: GenCtx,
): Promise<ArtifactSummary> {
  const parent = getArtifact(artifactId, ctx.userId);
  if (!parent) throw new Error("Artifact not found");
  if (parent.kind !== "webpage") throw new Error("Not a design artifact");
  const parentContent = fromJson<DesignContent>(parent.content);
  const currentHtml = parentContent?.html?.trim();
  if (!currentHtml) throw new Error("Design has no HTML to revise");

  const parentMeta = fromJson<Record<string, unknown>>(parent.meta) ?? {};
  const formatId =
    typeof parentContent?.format === "string"
      ? parentContent.format
      : typeof parentMeta.format === "string"
        ? parentMeta.format
        : "poster";
  const format = getFormat(formatId) ?? getFormat("poster")!;
  const palette = (PALETTES as readonly string[]).includes(parentMeta.palette as string)
    ? (parentMeta.palette as DesignPalette)
    : "vibrant";
  const model =
    typeof parentMeta.model === "string" ? parentMeta.model : MODELS.default;

  ctx.emit({ type: "status", label: "Applying your changes" });

  const system = [
    buildSystemPrompt(format, palette),
    `You are editing an EXISTING static graphic design. Apply the requested change and return the FULL revised document at the SAME EXACT ${format.width}×${format.height}px canvas — the same hard rules still apply (one self-contained HTML file, a single \`#design-canvas\` root at those exact dimensions, no network, no code fence). Preserve everything the change doesn't touch.`,
  ].join("\n\n");

  const prompt = [
    "Revise this graphic design per the instruction. Output the COMPLETE revised HTML document only.",
    `Instruction: ${instruction}`,
    "Current document:",
    currentHtml,
  ].join("\n\n");

  const html = await streamHtml({ system, prompt, model, ctx });
  if (ctx.signal.aborted) throw new Error("aborted");

  const title = extractTitle(html) ?? parent.title;
  return persistDesign({
    html,
    title,
    format,
    palette,
    prompt: instruction,
    model,
    ctx,
    parentId: parent.id,
  });
}

export const designGenerator: GeneratorService<DesignInput> = {
  name: "design",
  inputSchema: DesignInputSchema,
  toolDescription:
    "Design a single static, print-quality graphic (poster, social post, flyer, cover, logo, business card, ad banner…) as one self-contained HTML+SVG document at an exact pixel size, previewed live and exportable to PNG. Choose a format and a design-system palette (vibrant, elegant, minimal, bold, pastel, dark-luxe).",
  run: runDesign,
  revise: reviseDesign,
};
