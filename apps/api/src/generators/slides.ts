// Slides generator: prompt (+ optional hub grounding) -> a bespoke slide
// deck as structured JSON -> artifact row (kind 'slides').
//
// Two-pass design:
//   Pass 1 (outline)  : callLLMJSON<Outline> picks a title + an ordered list
//                       of {title, archetype, talking_points} over 7
//                       archetypes. MODELS.default.
//   Pass 2 (per slide): callLLMJSON fills the archetype's concrete fields;
//                       'image+text' slides also get art from the image
//                       service, written as a CHILD image artifact whose id
//                       is stored on the slide (image_artifact_id). The
//                       renderer/pptx export resolve it via
//                       /api/artifacts/<imgId>/blob.
//
// artifacts.content shape (DeckContent) is the single source of truth,
// mirrored byte-for-byte by apps/web/src/lib/slide-types.ts:
//   { theme: Theme, slides: SlideSpec[] }
// The full theme TOKEN SET (colors + font names) is embedded in content so a
// deck is self-describing and portable — the frontend and the .pptx export
// never need this file's THEMES registry.
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  DATA_DIR,
  MODELS,
  callLLMJSON,
  embedText,
  fromJson,
  generateImageBytes,
  logger,
  one,
  run,
  uuid,
} from "@omni/sdk";
import { searchHubMemory } from "../lib/hub-memory.js";
import {
  getArtifact,
  insertArtifact,
  toArtifactSummary,
  type ArtifactRow,
  type ArtifactSummary,
  type GenCtx,
  type GeneratorService,
} from "./types.js";

// ─── Theme tokens ───────────────────────────────────────────────────
//
// A deck's Theme is a fixed, code-controlled token set (NOT emitted by the
// LLM — colours are too important to hallucinate). Colours are `#RRGGBB`
// hex: the renderer uses them via inline style, the .pptx export strips the
// leading `#`. Keep this interface identical to slide-types.ts on the web.

export interface Theme {
  id: string;
  name: string;
  /** Solid background fallback (equals bgFrom). */
  bg: string;
  bgFrom: string;
  bgTo: string;
  /** Card / panel surface painted on top of the slide background. */
  surface: string;
  text: string;
  textMuted: string;
  accent: string;
  accent2: string;
  border: string;
  fontHeading: string;
  fontBody: string;
}

export const THEMES: Record<string, Theme> = {
  midnight: {
    id: "midnight",
    name: "Midnight",
    bg: "#0B1020",
    bgFrom: "#0B1020",
    bgTo: "#171E3C",
    surface: "#1B2141",
    text: "#F5F7FF",
    textMuted: "#A8B0D6",
    accent: "#818CF8",
    accent2: "#C4B5FD",
    border: "#2C335C",
    fontHeading: "Sora",
    fontBody: "Inter",
  },
  daylight: {
    id: "daylight",
    name: "Daylight",
    bg: "#FFFFFF",
    bgFrom: "#FFFFFF",
    bgTo: "#EEF1F8",
    surface: "#F5F6FA",
    text: "#181820",
    textMuted: "#5B6072",
    accent: "#4F46E5",
    accent2: "#7C3AED",
    border: "#E3E5ED",
    fontHeading: "Sora",
    fontBody: "Inter",
  },
  sunrise: {
    id: "sunrise",
    name: "Sunrise",
    bg: "#FFF7F0",
    bgFrom: "#FFE7D3",
    bgTo: "#FFF7F0",
    surface: "#FFFFFF",
    text: "#2A1A12",
    textMuted: "#7A5A46",
    accent: "#E4572E",
    accent2: "#F2A03D",
    border: "#F3D9C4",
    fontHeading: "Sora",
    fontBody: "Inter",
  },
  forest: {
    id: "forest",
    name: "Forest",
    bg: "#0C1F17",
    bgFrom: "#0C1F17",
    bgTo: "#123528",
    surface: "#123528",
    text: "#EAF5EE",
    textMuted: "#9FC3AE",
    accent: "#34D399",
    accent2: "#A7F3D0",
    border: "#1F4A38",
    fontHeading: "Sora",
    fontBody: "Inter",
  },
};

// ─── SlideSpec union (7 archetypes) ─────────────────────────────────
//
// Types are inferred from the Zod schema so validation and the TS shape can
// never drift. slide-types.ts on the web re-declares the same shapes.

const columnSchema = z.object({
  heading: z.string().optional(),
  points: z.array(z.string()),
});

const chartDataSchema = z.object({
  type: z.enum(["bar", "line", "pie"]),
  categories: z.array(z.string()),
  values: z.array(z.number()),
  series_label: z.string().optional(),
  unit: z.string().optional(),
  caption: z.string().optional(),
});

const slideSchema = z.discriminatedUnion("archetype", [
  z.object({
    archetype: z.literal("title"),
    title: z.string(),
    subtitle: z.string().optional(),
    eyebrow: z.string().optional(),
    notes: z.string().optional(),
  }),
  z.object({
    archetype: z.literal("section"),
    title: z.string(),
    subtitle: z.string().optional(),
    notes: z.string().optional(),
  }),
  z.object({
    archetype: z.literal("bullets"),
    title: z.string(),
    subtitle: z.string().optional(),
    bullets: z.array(z.string()),
    notes: z.string().optional(),
  }),
  z.object({
    archetype: z.literal("two-col"),
    title: z.string(),
    left: columnSchema,
    right: columnSchema,
    notes: z.string().optional(),
  }),
  z.object({
    archetype: z.literal("image+text"),
    title: z.string(),
    body: z.array(z.string()),
    image_prompt: z.string(),
    image_artifact_id: z.string().nullable(),
    image_side: z.enum(["left", "right"]),
    caption: z.string().optional(),
    notes: z.string().optional(),
  }),
  z.object({
    archetype: z.literal("quote"),
    quote: z.string(),
    attribution: z.string().optional(),
    notes: z.string().optional(),
  }),
  z.object({
    archetype: z.literal("chart"),
    title: z.string(),
    chart: chartDataSchema,
    notes: z.string().optional(),
  }),
]);

export type SlideSpec = z.infer<typeof slideSchema>;
export type Archetype = SlideSpec["archetype"];
export type ChartData = z.infer<typeof chartDataSchema>;

export interface DeckContent {
  theme: Theme;
  slides: SlideSpec[];
}

const ARCHETYPES: Archetype[] = [
  "title",
  "section",
  "bullets",
  "two-col",
  "image+text",
  "quote",
  "chart",
];

// ─── Input ──────────────────────────────────────────────────────────

const SlidesInputSchema = z.object({
  prompt: z.string().min(1).max(8000),
  hub_id: z.string().nullable().optional(),
  slide_count: z.number().int().min(4).max(20).default(8),
  theme: z.enum(["midnight", "daylight", "sunrise", "forest"]).default("midnight"),
  // Override mainly for tests; defaults to the registry default.
  model: z.string().optional(),
});

export type SlidesInput = z.infer<typeof SlidesInputSchema>;

// ─── Pass-1 outline shapes ──────────────────────────────────────────

interface OutlineSlide {
  title: string;
  archetype: string;
  talking_points: string[];
}
interface Outline {
  title: string;
  slides: OutlineSlide[];
}

// How many heavyweight slides we allow regardless of what the model asks
// for — image gen is slow/costly and too many charts read as filler.
const MAX_IMAGE_SLIDES = 4;
const MAX_CHART_SLIDES = 2;

// ─── Helpers ────────────────────────────────────────────────────────

function titleFromPrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

function toStringList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === "string" ? x : String(x ?? "")))
    .map((s) => s.replace(/^[\s•\-*]+/, "").trim())
    .filter((s) => s.length > 0)
    .slice(0, max);
}

function normalizeArchetype(a: unknown): Archetype {
  const s = String(a ?? "").toLowerCase().trim().replace(/\s+/g, "");
  if (s === "two-col" || s === "twocol" || s === "two_column" || s === "twocolumn")
    return "two-col";
  if (s === "image+text" || s === "imagetext" || s === "image_text" || s === "image")
    return "image+text";
  return (ARCHETYPES.find((k) => k === s) ?? "bullets") as Archetype;
}

/** Cap heavyweight archetypes, downgrading the overflow to plain bullets. */
function balanceArchetypes(slides: OutlineSlide[]): OutlineSlide[] {
  let images = 0;
  let charts = 0;
  return slides.map((s, i) => {
    let a = normalizeArchetype(s.archetype);
    if (i === 0) a = "title"; // deck always opens on a title slide
    if (a === "image+text") {
      if (images >= MAX_IMAGE_SLIDES) a = "bullets";
      else images++;
    } else if (a === "chart") {
      if (charts >= MAX_CHART_SLIDES) a = "bullets";
      else charts++;
    }
    return { ...s, archetype: a };
  });
}

function artPrompt(theme: Theme, prompt: string): string {
  return [
    prompt.trim(),
    `Style: a clean, modern editorial illustration for a presentation slide, cohesive with a "${theme.name}" colour mood (accents ${theme.accent} and ${theme.accent2} over a ${theme.bg} background). 16:9 composition with generous negative space. No text, no words, no letters, no charts, no UI.`,
  ].join("\n\n");
}

// ─── Prompt assembly ────────────────────────────────────────────────

function outlineSystem(): string {
  return [
    "You are a world-class presentation designer. Plan a slide deck as a JSON outline.",
    "The 7 available slide archetypes:",
    "- title: the opening slide (deck title + one-line subtitle). Always slide 1.",
    "- section: a divider announcing a new part of the talk (short title).",
    "- bullets: a headline with 3–6 punchy supporting points.",
    "- two-col: two labelled columns — great for compare/contrast, before/after, pros/cons.",
    "- image+text: a visual concept beside 2–4 short lines. Use when an illustration adds meaning.",
    "- quote: one memorable line (a quote or a bold takeaway) with attribution.",
    "- chart: ONE simple bar, line, or pie with concrete illustrative numbers.",
    "",
    "Rules:",
    "- Produce a tight, well-sequenced narrative with variety — never the same archetype many times in a row.",
    "- Use at most a couple of image+text slides and at most 2 chart slides.",
    "- talking_points: 2–5 terse notes that pass 2 will expand into the slide's real content.",
    "- Output JSON exactly: {\"title\": string, \"slides\": [{\"title\": string, \"archetype\": string, \"talking_points\": string[]}]}",
  ].join("\n");
}

/** Per-archetype instruction for pass 2 — the exact JSON fields to return. */
function slideFillInstruction(a: Archetype): string {
  switch (a) {
    case "title":
      return 'Return {"subtitle": string (one compelling sentence framing the deck), "eyebrow": string (a 2–4 word kicker)}.';
    case "section":
      return 'Return {"subtitle": string (one short line, optional but preferred)}.';
    case "bullets":
      return 'Return {"bullets": string[] (3–6 items, each a concise phrase under ~90 chars, no leading bullet punctuation), "subtitle": string (optional one-line framing)}.';
    case "two-col":
      return 'Return {"left": {"heading": string, "points": string[] (2–4)}, "right": {"heading": string, "points": string[] (2–4)}}.';
    case "image+text":
      return 'Return {"body": string[] (2–4 short supporting lines), "image_prompt": string (a vivid, literal visual scene to illustrate this slide — describe subject/setting/mood, NO text or charts in the image), "image_side": "left" | "right", "caption": string (optional short image caption)}.';
    case "quote":
      return 'Return {"quote": string (one memorable line under ~160 chars), "attribution": string (who said it or the source; optional)}.';
    case "chart":
      return 'Return {"chart": {"type": "bar" | "line" | "pie", "categories": string[] (3–6 labels), "values": number[] (one plausible number per category, same length), "series_label": string (what the numbers measure), "unit": string (optional, e.g. "%", "$M"), "caption": string (optional one-line takeaway)}}.';
  }
}

// ─── Slide coercion + validation ────────────────────────────────────

/**
 * Build a validated SlideSpec from an outline slide + the model's pass-2
 * fill. Falls back to a bullets slide (from talking_points) whenever the
 * fill is unusable, so one bad slide never sinks the deck.
 */
function buildSlide(
  outline: OutlineSlide,
  archetype: Archetype,
  filled: Record<string, unknown>,
  deckTitle: string,
): SlideSpec {
  const title = (outline.title || deckTitle).trim();

  const bulletsFallback = (): SlideSpec => ({
    archetype: "bullets",
    title: title || "Untitled",
    bullets:
      toStringList(outline.talking_points, 6).length > 0
        ? toStringList(outline.talking_points, 6)
        : ["(no content)"],
  });

  let candidate: unknown;
  switch (archetype) {
    case "title":
      candidate = {
        archetype: "title",
        title: deckTitle || title,
        subtitle: str(filled.subtitle),
        eyebrow: str(filled.eyebrow),
      };
      break;
    case "section":
      candidate = {
        archetype: "section",
        title,
        subtitle: str(filled.subtitle),
      };
      break;
    case "bullets": {
      const bullets = toStringList(filled.bullets, 6);
      if (bullets.length === 0) return bulletsFallback();
      candidate = { archetype: "bullets", title, bullets, subtitle: str(filled.subtitle) };
      break;
    }
    case "two-col": {
      const l = (filled.left ?? {}) as Record<string, unknown>;
      const r = (filled.right ?? {}) as Record<string, unknown>;
      const left = { heading: str(l.heading), points: toStringList(l.points, 5) };
      const right = { heading: str(r.heading), points: toStringList(r.points, 5) };
      if (left.points.length === 0 && right.points.length === 0) return bulletsFallback();
      candidate = { archetype: "two-col", title, left, right };
      break;
    }
    case "image+text": {
      const body = toStringList(filled.body, 4);
      const image_prompt = str(filled.image_prompt) ?? title;
      const side = filled.image_side === "left" ? "left" : "right";
      candidate = {
        archetype: "image+text",
        title,
        body: body.length > 0 ? body : toStringList(outline.talking_points, 4),
        image_prompt,
        image_artifact_id: null,
        image_side: side,
        caption: str(filled.caption),
      };
      break;
    }
    case "quote": {
      const quote = str(filled.quote);
      if (!quote) return bulletsFallback();
      candidate = { archetype: "quote", quote, attribution: str(filled.attribution) };
      break;
    }
    case "chart": {
      const raw = (filled.chart ?? filled) as Record<string, unknown>;
      const categories = toStringList(raw.categories, 6);
      const values = Array.isArray(raw.values)
        ? (raw.values as unknown[]).map((n) => Number(n)).filter((n) => Number.isFinite(n))
        : [];
      const len = Math.min(categories.length, values.length);
      if (len < 2) return bulletsFallback();
      const type =
        raw.type === "line" || raw.type === "pie" ? raw.type : "bar";
      candidate = {
        archetype: "chart",
        title,
        chart: {
          type,
          categories: categories.slice(0, len),
          values: values.slice(0, len),
          series_label: str(raw.series_label),
          unit: str(raw.unit),
          caption: str(raw.caption),
        },
      };
      break;
    }
  }

  const parsed = slideSchema.safeParse(dropUndefined(candidate));
  return parsed.success ? parsed.data : bulletsFallback();
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
}

// Zod's discriminatedUnion tolerates missing optionals but not `undefined`
// values on some builds; strip undefined keys before parsing.
function dropUndefined<T>(obj: T): T {
  if (!obj || typeof obj !== "object") return obj;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// ─── Slide art ──────────────────────────────────────────────────────

/**
 * Generate art for an image+text slide and persist it as a CHILD image
 * artifact (kind 'image', parent_id = deckId). Returns the new artifact id,
 * or null on a soft failure (the renderer then shows a themed placeholder).
 * Aborts propagate.
 */
async function generateSlideArt(
  deckId: string,
  slideIndex: number,
  theme: Theme,
  prompt: string,
  deckTitle: string,
  ctx: GenCtx,
): Promise<string | null> {
  try {
    const bytes = await generateImageBytes(artPrompt(theme, prompt), undefined, ctx.signal);
    if (ctx.signal.aborted) throw new Error("aborted");
    const imgId = uuid();
    const relPath = `artifacts/${imgId}.png`;
    const absPath = join(DATA_DIR, relPath);
    await writeFile(`${absPath}.part`, bytes);
    await rename(`${absPath}.part`, absPath);
    insertArtifact({
      id: imgId,
      userId: ctx.userId,
      kind: "image",
      title: `${deckTitle} — slide ${slideIndex + 1}`,
      relPath,
      parentId: deckId,
      meta: { prompt, aspect_ratio: "16:9", deck_id: deckId, slide_index: slideIndex },
    });
    return imgId;
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    logger.warn(
      { err: (err as Error).message?.slice(0, 200), deckId, slideIndex },
      "[slides] slide art generation failed; slide keeps a placeholder",
    );
    return null;
  }
}

// ─── Deck persistence ───────────────────────────────────────────────

function insertDeckShell(opts: {
  id: string;
  userId: string;
  title: string;
  theme: Theme;
  hubId: string | null;
  parentId: string | null;
  meta: Record<string, unknown>;
}): ArtifactRow {
  return insertArtifact({
    id: opts.id,
    userId: opts.userId,
    kind: "slides",
    title: opts.title,
    content: { theme: opts.theme, slides: [] } satisfies DeckContent,
    hubId: opts.hubId,
    parentId: opts.parentId,
    meta: opts.meta,
  });
}

function saveDeckContent(deckId: string, content: DeckContent): void {
  run("UPDATE artifacts SET content = ? WHERE id = ?", JSON.stringify(content), deckId);
}

// ─── Pass 2 fill (shared) ───────────────────────────────────────────

async function fillSlide(
  outline: OutlineSlide,
  archetype: Archetype,
  deckTitle: string,
  model: string,
  ctx: GenCtx,
): Promise<SlideSpec> {
  // The quote/title archetypes need almost nothing; still round-trip through
  // the model for on-brand copy, but a failure just falls back cleanly.
  const system = [
    "You are writing the content of ONE slide in a presentation deck.",
    "Be specific, concrete, and concise — presentation voice, not prose.",
    slideFillInstruction(archetype),
  ].join("\n\n");

  const prompt = [
    `Deck: ${deckTitle}`,
    `This slide's working title: ${outline.title}`,
    `Archetype: ${archetype}`,
    outline.talking_points?.length
      ? `Notes to expand:\n${toStringList(outline.talking_points, 6).map((t) => `- ${t}`).join("\n")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const filled = await callLLMJSON<Record<string, unknown>>({
      system,
      prompt,
      model,
      maxTokens: 1200,
    });
    return buildSlide(outline, archetype, filled ?? {}, deckTitle);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    logger.warn(
      { err: (err as Error).message?.slice(0, 160), title: outline.title },
      "[slides] slide fill failed; using talking-points fallback",
    );
    return buildSlide(outline, archetype, {}, deckTitle);
  }
}

// ─── run() ──────────────────────────────────────────────────────────

async function runSlides(input: SlidesInput, ctx: GenCtx): Promise<ArtifactSummary> {
  const model = input.model ?? MODELS.default;
  const theme = THEMES[input.theme] ?? THEMES.midnight;

  // Optional hub grounding, mirroring the doc generator.
  let grounding: string | undefined;
  if (input.hub_id) {
    ctx.emit({ type: "status", label: "Searching hub memory" });
    const embedding = await embedText(input.prompt);
    if (embedding) {
      const hits = searchHubMemory(input.hub_id, embedding, 10);
      if (hits.length > 0) {
        let budget = 9_000;
        const parts: string[] = ["Reference material from the user's hub:"];
        for (const h of hits) {
          const entry = `[${h.cite_label}] ${h.chunk_text.slice(0, 1000)}`;
          if (entry.length > budget) break;
          budget -= entry.length;
          parts.push(entry);
        }
        grounding = parts.join("\n\n");
      }
    }
  }
  if (ctx.signal.aborted) throw new Error("aborted");

  // ── Pass 1: outline ──
  ctx.emit({ type: "status", label: "Outlining the deck" });
  const outline = await callLLMJSON<Outline>({
    system: outlineSystem(),
    cachedContext: grounding,
    prompt: [
      `Design a ${input.slide_count}-slide deck.`,
      `Topic / request: ${input.prompt}`,
      `Produce EXACTLY ${input.slide_count} slides.`,
      grounding ? "Ground the content in the reference material above where relevant." : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    model,
    maxTokens: 2500,
  });
  if (ctx.signal.aborted) throw new Error("aborted");

  const deckTitle = (outline?.title || titleFromPrompt(input.prompt)).trim();
  let outlineSlides = Array.isArray(outline?.slides) ? outline.slides : [];
  if (outlineSlides.length === 0) {
    outlineSlides = [{ title: deckTitle, archetype: "title", talking_points: [] }];
  }
  outlineSlides = balanceArchetypes(outlineSlides.slice(0, input.slide_count));
  const total = outlineSlides.length;

  // ── Persist the deck shell FIRST so child image artifacts have a valid
  // parent_id (artifacts.parent_id is a FK to artifacts.id). ──
  const deckId = uuid();
  const deckRow = insertDeckShell({
    id: deckId,
    userId: ctx.userId,
    title: deckTitle,
    theme,
    hubId: input.hub_id ?? null,
    parentId: null,
    meta: {
      prompt: input.prompt,
      slide_count: total,
      theme: theme.id,
      model,
    },
  });

  // Let the UI paint a live outline / progress checklist.
  ctx.emit({
    type: "delta",
    channel: "outline",
    data: JSON.stringify({
      title: deckTitle,
      slides: outlineSlides.map((s) => ({
        title: s.title,
        archetype: normalizeArchetype(s.archetype),
      })),
    }),
  });

  // ── Pass 2: fill + art, slide by slide ──
  const slides: SlideSpec[] = [];
  for (let i = 0; i < total; i++) {
    if (ctx.signal.aborted) throw new Error("aborted");
    const o = outlineSlides[i];
    const archetype = normalizeArchetype(o.archetype);
    ctx.emit({ type: "status", label: `Designing slide ${i + 1}/${total}` });
    const slide = await fillSlide(o, archetype, deckTitle, model, ctx);

    if (slide.archetype === "image+text") {
      ctx.emit({ type: "status", label: `Generating art for slide ${i + 1}/${total}` });
      slide.image_artifact_id = await generateSlideArt(
        deckId,
        i,
        theme,
        slide.image_prompt,
        deckTitle,
        ctx,
      );
    }

    slides.push(slide);
    ctx.emit({ type: "delta", channel: "slide_done", data: JSON.stringify({ index: i }) });
  }

  const content: DeckContent = { theme, slides };
  saveDeckContent(deckId, content);
  const finalRow =
    one<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?", deckId) ?? deckRow;
  return toArtifactSummary(finalRow);
}

// ─── revise() ───────────────────────────────────────────────────────

const reviseDeckSchema = z.object({
  theme: z.string().optional(),
  slides: z.array(z.record(z.unknown())),
});

async function reviseSlides(
  artifactId: string,
  instruction: string,
  ctx: GenCtx,
): Promise<ArtifactSummary> {
  const parent = getArtifact(artifactId, ctx.userId);
  if (!parent) throw new Error("Artifact not found");
  if (parent.kind !== "slides") throw new Error("Not a slides artifact");
  const parentContent = fromJson<DeckContent>(parent.content);
  if (!parentContent?.slides?.length) throw new Error("Deck has no slides to revise");

  const model = MODELS.default;

  ctx.emit({ type: "status", label: "Rethinking the deck" });

  // Feed the current deck to the model WITHOUT image_artifact_ids (ids are
  // meaningless to the model); keep image_prompt so it can decide to reuse.
  const stripped = parentContent.slides.map((s) =>
    s.archetype === "image+text"
      ? { ...s, image_artifact_id: undefined }
      : s,
  );

  const system = [
    "You are revising an existing slide deck. Apply the user's instruction and return the FULL updated deck.",
    "Keep the same 7 archetypes available (title, section, bullets, two-col, image+text, quote, chart).",
    "Preserve slides the instruction doesn't touch. For image+text slides you keep unchanged, keep their exact image_prompt so their art can be reused.",
    'Output JSON: {"theme": "midnight"|"daylight"|"sunrise"|"forest" (optional — only if the instruction asks to restyle), "slides": SlideSpec[] }.',
    "Each SlideSpec must include its archetype and that archetype's fields (image+text slides need title, body[], image_prompt, image_side).",
  ].join("\n\n");

  const revised = await callLLMJSON<z.infer<typeof reviseDeckSchema>>({
    system,
    prompt: [
      `Instruction: ${instruction}`,
      "Current deck (JSON):",
      JSON.stringify({ theme: parentContent.theme.id, slides: stripped }),
    ].join("\n\n"),
    model,
    maxTokens: 6000,
  });
  if (ctx.signal.aborted) throw new Error("aborted");

  const parseResult = reviseDeckSchema.safeParse(revised);
  const draftSlides = parseResult.success ? parseResult.data.slides : [];
  if (draftSlides.length === 0) throw new Error("Revision produced no slides");

  const theme =
    (revised?.theme && THEMES[revised.theme]) || parentContent.theme;

  const deckTitle = parent.title;
  const deckId = uuid();
  const deckRow = insertDeckShell({
    id: deckId,
    userId: ctx.userId,
    title: deckTitle,
    theme,
    hubId: parent.hub_id,
    parentId: parent.id,
    meta: {
      ...(fromJson<Record<string, unknown>>(parent.meta) ?? {}),
      slide_count: draftSlides.length,
      theme: theme.id,
      model,
      revised_from: parent.id,
      instruction,
    },
  });

  // Reuse the parent's art when the model kept a slide's image_prompt.
  const artByPrompt = new Map<string, string>();
  for (const s of parentContent.slides) {
    if (s.archetype === "image+text" && s.image_artifact_id) {
      artByPrompt.set(s.image_prompt.trim(), s.image_artifact_id);
    }
  }

  const total = draftSlides.length;
  const slides: SlideSpec[] = [];
  for (let i = 0; i < total; i++) {
    if (ctx.signal.aborted) throw new Error("aborted");
    const draft = draftSlides[i];
    const archetype = normalizeArchetype(draft.archetype);
    const outlineLike: OutlineSlide = {
      title: str(draft.title) ?? deckTitle,
      archetype,
      talking_points: toStringList(draft.body ?? draft.bullets, 6),
    };
    ctx.emit({ type: "status", label: `Updating slide ${i + 1}/${total}` });
    const slide = buildSlide(outlineLike, archetype, draft, deckTitle);

    if (slide.archetype === "image+text") {
      const reuse = artByPrompt.get(slide.image_prompt.trim());
      if (reuse) {
        slide.image_artifact_id = reuse;
      } else {
        ctx.emit({ type: "status", label: `Generating art for slide ${i + 1}/${total}` });
        slide.image_artifact_id = await generateSlideArt(
          deckId,
          i,
          theme,
          slide.image_prompt,
          deckTitle,
          ctx,
        );
      }
    }

    slides.push(slide);
    ctx.emit({ type: "delta", channel: "slide_done", data: JSON.stringify({ index: i }) });
  }

  saveDeckContent(deckId, { theme, slides });
  const finalRow =
    one<ArtifactRow>("SELECT * FROM artifacts WHERE id = ?", deckId) ?? deckRow;
  return toArtifactSummary(finalRow);
}

export const slidesGenerator: GeneratorService<SlidesInput> = {
  name: "slides",
  inputSchema: SlidesInputSchema,
  toolDescription:
    "Design a polished slide deck from a prompt (7 archetypes: title, section, bullets, two-column, image+text, quote, chart) with a chosen theme; optionally grounded in a hub's files. Generates slide art via the image service.",
  run: runSlides,
  revise: reviseSlides,
};
