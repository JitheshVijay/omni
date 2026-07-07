// Meeting notes generator: paste a raw transcript -> streamed
// GitHub-flavored Markdown meeting notes -> artifact row (kind 'doc').
//
// Content shape (same as doc.ts, so /tools/docs/:id renders it):
//   { markdown, blocks: null, sources: [] }
// The notes always follow a fixed structure: Summary, Key Points,
// Decisions, Action Items (a table Owner | Task | Due), Open Questions.
// meta {subtype:"meeting", model} lets the Meeting Notes page filter its
// "Recent notes" grid client-side.
import { z } from "zod";
import {
  LLM_REQUEST_OPTS,
  MODELS,
  fromJson,
  openai,
  providerRoutingForCache,
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

const MeetingInputSchema = z.object({
  transcript: z.string().min(20).max(60_000),
  title: z.string().max(200).optional(),
  // Override mainly for tests; defaults to the registry default.
  model: z.string().optional(),
});

export type MeetingInput = z.infer<typeof MeetingInputSchema>;

interface DocContent {
  markdown: string;
  blocks?: unknown[] | null;
  sources: unknown[];
}

// ─── Title helpers (exported for tests) ─────────────────────────────

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

/** Fallback title: the first non-empty transcript line, clipped. */
export function titleFromTranscript(transcript: string): string {
  const firstLine =
    transcript
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "Meeting";
  const flat = firstLine.replace(/\s+/g, " ").trim();
  const clipped = flat.length > 70 ? `${flat.slice(0, 67)}...` : flat;
  return `Meeting notes — ${clipped}`;
}

// ─── Prompts ────────────────────────────────────────────────────────

const NOTES_SPEC = [
  "Produce clean, well-structured meeting notes as GitHub-flavored Markdown with EXACTLY these sections, in this order:",
  "1. A single H1 title line (`# Title`) — a short, specific title for the meeting.",
  "2. `## Summary` — one tight paragraph capturing what the meeting was about and its outcome.",
  "3. `## Key Points` — a bulleted list of the most important discussion points.",
  "4. `## Decisions` — a bulleted list of concrete decisions made (write `- None recorded.` if there were none).",
  "5. `## Action Items` — a Markdown table with the header row `| Owner | Task | Due |` and a separator row, one row per action item. Use the named person as Owner when known, otherwise `Unassigned`; use the stated deadline as Due when known, otherwise `—`. If there are no action items, write `- None recorded.` instead of a table.",
  "6. `## Open Questions` — a bulleted list of unresolved questions or follow-ups (write `- None recorded.` if there were none).",
].join("\n");

function buildSystemPrompt(): string {
  return [
    "You are an expert meeting-notes writer. You are given a raw meeting transcript (from Zoom, Google Meet, Microsoft Teams, or hand-typed notes) and turn it into structured notes.",
    [
      "Rules:",
      "- Output ONLY the notes themselves — no preamble, no commentary, and no code fence wrapping the whole document.",
      "- Base everything strictly on the transcript; never invent decisions, owners, or dates that aren't supported by it.",
      "- Be concise and skimmable; prefer crisp bullets over long prose.",
    ].join("\n"),
    NOTES_SPEC,
  ].join("\n\n");
}

// ─── Streaming ──────────────────────────────────────────────────────

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
  prompt: string;
  model: string;
  ctx: GenCtx;
}): Promise<string> {
  const { ctx } = opts;
  const messages: OaiMessage[] = [
    { role: "system", content: wrapSystemForCache(opts.system, opts.model) },
    { role: "user", content: opts.prompt },
  ];

  ctx.emit({ type: "status", label: "Writing notes" });
  const stream = await createChatStream(
    {
      model: opts.model,
      messages,
      stream: true,
      max_tokens: 3500,
      // Disable extended thinking so the whole budget goes to the notes, not
      // to reasoning tokens (which would stream zero content -> "empty notes").
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
  if (!markdown.trim()) throw new Error("Model produced empty notes");
  return markdown;
}

// ─── Generator ──────────────────────────────────────────────────────

async function runMeeting(input: MeetingInput, ctx: GenCtx): Promise<ArtifactSummary> {
  const model = input.model ?? MODELS.default;

  ctx.emit({ type: "status", label: "Reading the transcript" });

  const prompt = [
    "Turn the following meeting transcript into structured meeting notes per the required format.",
    "Transcript:",
    input.transcript,
  ].join("\n\n");

  const markdown = await streamMarkdown({
    system: buildSystemPrompt(),
    prompt,
    model,
    ctx,
  });

  const title = input.title?.trim() || extractTitle(markdown) || titleFromTranscript(input.transcript);
  const content: DocContent = { markdown, blocks: null, sources: [] };
  const row = insertArtifact({
    userId: ctx.userId,
    kind: "doc",
    title,
    content,
    meta: { subtype: "meeting", model },
  });
  return toArtifactSummary(row);
}

async function reviseMeeting(
  artifactId: string,
  instruction: string,
  ctx: GenCtx,
): Promise<ArtifactSummary> {
  const parent = getArtifact(artifactId, ctx.userId);
  if (!parent) throw new Error("Artifact not found");
  if (parent.kind !== "doc") throw new Error("Not a doc artifact");
  const parentContent = fromJson<DocContent>(parent.content);
  const currentMarkdown = parentContent?.markdown?.trim();
  if (!currentMarkdown) throw new Error("Notes have no markdown to revise");

  const parentMeta = fromJson<Record<string, unknown>>(parent.meta);
  const model =
    typeof parentMeta?.model === "string" ? parentMeta.model : MODELS.default;

  ctx.emit({ type: "status", label: "Reading the transcript" });

  const system = [
    "You are an expert meeting-notes editor working in GitHub-flavored Markdown.",
    [
      "Rules:",
      "- Output ONLY the revised notes — no preamble, no commentary, no code fence wrapping the whole document.",
      "- Keep the same section structure unless the instruction explicitly asks to change it.",
    ].join("\n"),
    NOTES_SPEC,
  ].join("\n\n");

  const prompt = [
    "Revise the following meeting notes per the instruction. Output the FULL revised notes as markdown only.",
    `Instruction: ${instruction}`,
    "Current notes:",
    currentMarkdown,
  ].join("\n\n");

  const markdown = await streamMarkdown({ system, prompt, model, ctx });

  const content: DocContent = { markdown, blocks: null, sources: [] };
  const row = insertArtifact({
    userId: ctx.userId,
    kind: "doc",
    title: extractTitle(markdown) ?? parent.title,
    content,
    parentId: parent.id,
    meta: { subtype: "meeting", model },
  });
  return toArtifactSummary(row);
}

export const meetingGenerator: GeneratorService<MeetingInput> = {
  name: "meeting",
  inputSchema: MeetingInputSchema,
  toolDescription:
    "Turn a raw meeting transcript into structured notes: summary, key points, decisions, action items (owner/task/due), and open questions.",
  run: runMeeting,
  revise: reviseMeeting,
};
