// Webapp generator ("AI Developer"): prompt (+ style) -> a single, complete,
// fully self-contained HTML5 document streamed token-by-token -> artifact row
// (kind 'webpage') with the html both stored in content {html} AND written to
// a blob at artifacts/<id>.html (so GET /blob and export-to-drive work).
//
// The output MUST run offline inside a sandboxed iframe with only
// allow-scripts: everything (CSS in <style>, JS in <script>) is inlined and
// there are NO external URLs/CDNs/fonts/network calls. The model tends to wrap
// its answer in a ```html fence; we strip that from the stream so the live
// iframe preview only ever sees real markup.
//
// Content shape stored in artifacts.content: { html }
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

// ─── Input ──────────────────────────────────────────────────────────

const STYLES = ["clean", "playful", "dark", "minimal"] as const;
type WebappStyle = (typeof STYLES)[number];

const WebappInputSchema = z.object({
  prompt: z.string().min(1).max(8000),
  style: z.enum(STYLES).default("clean"),
  // Override mainly for tests; defaults to the registry default.
  model: z.string().optional(),
});

export type WebappInput = z.infer<typeof WebappInputSchema>;

export interface WebappContent {
  html: string;
}

// ─── Pure helpers (exported for tests) ──────────────────────────────

/** Fallback title when there's no <title>: the prompt, clipped. */
export function titleFromPrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

/** The document's <title>, trimmed, or null when absent/empty. */
export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = m?.[1]?.replace(/\s+/g, " ").trim();
  return title ? title : null;
}

/**
 * Strip a markdown code fence the model may have wrapped the document in.
 * `ended=false` (mid-stream) holds back an as-yet-incomplete OPENING fence
 * line by returning null, so the live preview never flashes "```html". Once
 * the opening line resolves the result grows monotonically, which the caller
 * relies on to diff emitted length. Returns the cleaned HTML (or null).
 */
export function cleanFences(raw: string, ended: boolean): string | null {
  let s = raw.replace(/^/, "").replace(/^\s+/, "");
  const open = /^```[^\n]*\n/.exec(s);
  if (open) {
    s = s.slice(open[0].length);
  } else if (/^```/.test(s) && !ended) {
    // Opening fence line still arriving — don't emit a partial "```html".
    return null;
  }
  // Closing fence only ever appears at the very end of the document.
  s = s.replace(/\n?```\s*$/, "");
  if (ended) {
    // Salvage: if the model prefixed prose (e.g. "Here's your app:"), start the
    // document at the first real HTML tag so the preview never renders chatter.
    const start = /<!doctype html|<html[\s>]/i.exec(s);
    if (start && start.index > 0) s = s.slice(start.index);
    return s.trim();
  }
  return s;
}

// ─── Prompt assembly ────────────────────────────────────────────────

const STYLE_GUIDANCE: Record<WebappStyle, string> = {
  clean:
    "Style: clean and modern — a light, airy layout, a confident single accent color, generous whitespace, a system font stack, rounded corners, and subtle shadows. Professional SaaS aesthetic.",
  playful:
    "Style: playful and vibrant — bright saturated colors, bold rounded shapes, chunky friendly typography, gentle CSS animations and hover bounces, and a cheerful energetic mood.",
  dark:
    "Style: sleek dark mode — a deep near-black background, high-contrast light text, a glowing neon/gradient accent, glassy surfaces with soft borders, and a premium modern-tech feel.",
  minimal:
    "Style: strict minimalism — mostly monochrome, lots of negative space, a single restrained accent, hairline borders, small refined typography, and no decoration that isn't functional.",
};

function buildSystemPrompt(style: WebappStyle): string {
  return [
    "You are an elite front-end engineer. From the user's description you build a COMPLETE, working single-file web app.",
    [
      "HARD REQUIREMENTS — follow every one:",
      "- Output ONLY one HTML document, from `<!doctype html>` through `</html>`. No prose before or after, and DO NOT wrap it in a markdown code fence.",
      "- The document MUST be FULLY SELF-CONTAINED: ALL CSS in a single inline <style>, ALL JavaScript in a single inline <script>. Vanilla JS only — no frameworks, no build step.",
      "- ZERO network requests: no external URLs, no CDNs, no <link>/@import stylesheets, no web fonts, no remote images, no fetch/XHR/WebSocket. It must run fully offline inside a sandboxed iframe whose only permission is allow-scripts.",
      "- Need images/icons? Draw them with inline SVG, CSS, emoji, or canvas — never a remote src. Need fonts? Use the system font stack.",
      "- Make it genuinely FUNCTIONAL, not a mockup: wire up real interactivity and state with JS. Handle empty and edge states. It should feel finished and delightful.",
      "- CRITICAL — the app MUST fully render its real initial UI on load. Put the <script> at the end of <body> and CALL your init/render function immediately at the end of it (the DOM already exists) so everything is populated before the user sees it. NEVER ship literal placeholder text that code should have replaced (e.g. 'Month Year', 'Lorem ipsum', '{{value}}', empty grids): compute and fill the actual content (today's date, the current month's day cells, sample data, etc.) up front.",
      "- Write clean, responsive, accessible markup that looks great on both desktop and mobile.",
      "- Include a meaningful <title>.",
    ].join("\n"),
    STYLE_GUIDANCE[style],
  ].join("\n\n");
}

// ─── Streaming ──────────────────────────────────────────────────────

interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
}

type OaiMessage = { role: "system" | "user" | "assistant"; content: unknown };

// The OpenAI SDK's create() overloads fight structural message arrays under
// strict TS; bind a loosely-typed alias once (same pattern as doc.ts).
const createChatStream = openai.chat.completions.create.bind(
  openai.chat.completions,
) as unknown as (
  body: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<AsyncIterable<StreamChunk>>;

const MAX_TOKENS = 16_000;

/** Stream an HTML completion, forwarding fence-stripped chunks as deltas. */
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

  ctx.emit({ type: "status", label: "Writing the code" });
  const stream = await createChatStream(
    {
      model: opts.model,
      messages,
      stream: true,
      max_tokens: MAX_TOKENS,
      // CRITICAL: disable extended thinking. A reasoning-enabled Claude model
      // will spend the ENTIRE max_tokens budget "thinking" about a non-trivial
      // app and emit zero HTML (finish_reason: "length", content: ""), which
      // surfaced as "Model produced an empty document". Writing markup is a
      // direct task; no thinking budget needed.
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
  if (!html.trim()) {
    throw new EmptyDocumentError();
  }
  return html;
}

/** Thrown when the model returns no usable HTML — retried once by the caller. */
class EmptyDocumentError extends Error {
  constructor() {
    super("Model produced an empty document");
    this.name = "EmptyDocumentError";
  }
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
async function persistWebapp(opts: {
  html: string;
  title: string;
  meta: Record<string, unknown>;
  ctx: GenCtx;
  parentId?: string | null;
}): Promise<ArtifactSummary> {
  const id = uuid();
  const relPath = `artifacts/${id}.html`;
  const absPath = join(DATA_DIR, relPath);
  await writeFile(`${absPath}.part`, opts.html, "utf8");
  await rename(`${absPath}.part`, absPath);

  const content: WebappContent = { html: opts.html };
  const row = insertArtifact({
    id,
    userId: opts.ctx.userId,
    kind: "webpage",
    title: opts.title,
    content,
    relPath,
    parentId: opts.parentId ?? null,
    meta: opts.meta,
  });
  return toArtifactSummary(row);
}

// ─── Generator ──────────────────────────────────────────────────────

async function runWebapp(input: WebappInput, ctx: GenCtx): Promise<ArtifactSummary> {
  const model = input.model ?? MODELS.default;
  ctx.emit({ type: "status", label: "Designing the app" });

  const html = await streamHtmlWithRetry({
    system: buildSystemPrompt(input.style),
    prompt: input.prompt,
    model,
    ctx,
  });
  if (ctx.signal.aborted) throw new Error("aborted");

  const title = extractTitle(html) ?? titleFromPrompt(input.prompt);
  return persistWebapp({
    html,
    title,
    meta: { prompt: input.prompt, style: input.style, model },
    ctx,
  });
}

async function reviseWebapp(
  artifactId: string,
  instruction: string,
  ctx: GenCtx,
): Promise<ArtifactSummary> {
  const parent = getArtifact(artifactId, ctx.userId);
  if (!parent) throw new Error("Artifact not found");
  if (parent.kind !== "webpage") throw new Error("Not a webapp artifact");
  const parentContent = fromJson<WebappContent>(parent.content);
  const currentHtml = parentContent?.html?.trim();
  if (!currentHtml) throw new Error("Web app has no HTML to revise");

  const parentMeta = fromJson<Record<string, unknown>>(parent.meta) ?? {};
  const style = (STYLES as readonly string[]).includes(parentMeta.style as string)
    ? (parentMeta.style as WebappStyle)
    : "clean";
  const model =
    typeof parentMeta.model === "string" ? parentMeta.model : MODELS.default;

  ctx.emit({ type: "status", label: "Applying your changes" });

  const system = [
    buildSystemPrompt(style),
    "You are editing an EXISTING single-file web app. Apply the requested change and return the FULL revised document — the same hard requirements still apply (one self-contained HTML file, no network, no code fence). Preserve everything the change doesn't touch.",
  ].join("\n\n");

  const prompt = [
    `Revise this web app per the instruction. Output the COMPLETE revised HTML document only.`,
    `Instruction: ${instruction}`,
    "Current document:",
    currentHtml,
  ].join("\n\n");

  const html = await streamHtml({ system, prompt, model, ctx });
  if (ctx.signal.aborted) throw new Error("aborted");

  const title = extractTitle(html) ?? parent.title;
  return persistWebapp({
    html,
    title,
    meta: { prompt: instruction, style, model, revised_from: parent.id },
    ctx,
    parentId: parent.id,
  });
}

export const webappGenerator: GeneratorService<WebappInput> = {
  name: "webapp",
  inputSchema: WebappInputSchema,
  toolDescription:
    "Build a complete, self-contained single-file web app (HTML/CSS/JS in one file) from a description; runs in a sandboxed live preview. Choose a visual style (clean, playful, dark, minimal).",
  run: runWebapp,
  revise: reviseWebapp,
};
