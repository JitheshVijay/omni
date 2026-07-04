// Podcast generator: a topic prompt (or a doc artifact's markdown) -> a
// two-host dialogue script (MODELS.default, JSON) -> per-turn ElevenLabs
// TTS with two contrasting voices -> one stitched MP3 at artifacts/<id>.mp3
// + artifact row (kind 'audio', meta.subtype 'podcast').
//
// Stitching reuses the tts generator's proof that naive concatenation of
// eleven mp3_44100_128 buffers plays everywhere — no ffmpeg. Because that
// output is 128kbps CBR (~16,000 bytes/sec), each turn's start_sec for the
// script-synced player is estimated cumulatively from byte offsets.
// Audio artifacts are terminal — no revise().
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { env } from "@omni/env-config";
import { DATA_DIR, MODELS, callLLMJSON, fromJson, uuid } from "@omni/sdk";
import { stripMarkdown } from "../lib/markdown-strip.js";
import { TTS_VOICE_SETTINGS, resolveVoiceId } from "../lib/voice-catalog.js";
import {
  getArtifact,
  insertArtifact,
  toArtifactSummary,
  type ArtifactSummary,
  type GenCtx,
  type GeneratorService,
} from "./types.js";

const PodcastInputSchema = z
  .object({
    prompt: z.string().max(4000).optional(),
    artifact_id: z.string().optional(),
    minutes: z.number().int().min(1).max(10).default(3),
    voice_a: z.string().optional(),
    voice_b: z.string().optional(),
    // Override mainly for tests; defaults to the registry default.
    model: z.string().optional(),
  })
  .refine((d) => Boolean(d.prompt?.trim() || d.artifact_id), {
    message: "Provide a prompt or an artifact_id",
  });

export type PodcastInput = z.infer<typeof PodcastInputSchema>;

// Default host voices — two contrasting picks from lib/voice-catalog.ts:
//   Host A (curious): Alexandra — "Friendly, curious".
//   Host B (expert):  Daniel — "Authoritative British".
export const PODCAST_VOICE_A = "EXAVITQu4vr4xnSDxMaL"; // Alexandra
export const PODCAST_VOICE_B = "onwK4e9ZLuTAKqWW03F9"; // Daniel

// ─── Pure helpers (unit-tested in podcast.test.ts) ──────────────────

// Conversational speech lands around 150 spoken words per minute.
export const WORDS_PER_MINUTE = 150;
export const MIN_TURNS = 6;
export const MAX_TURNS = 20;

// eleven mp3_44100_128 is 128kbps CBR: 128,000 bits/sec = 16,000 bytes/sec.
export const MP3_BYTES_PER_SEC = 16_000;

/**
 * Script sizing from the requested episode length: a total spoken-word
 * budget (~150 wpm) and a target turn count, clamped to 6–20 turns so a
 * 1-minute episode still reads as a dialogue and a 10-minute one doesn't
 * fragment into soundbites.
 */
export function turnBudgetForMinutes(minutes: number): { words: number; turns: number } {
  const m = Math.min(Math.max(Math.round(minutes) || 1, 1), 10);
  return {
    words: m * WORDS_PER_MINUTE,
    turns: Math.min(Math.max(m * 3, MIN_TURNS), MAX_TURNS),
  };
}

/** Byte offset/length -> seconds under the 128kbps CBR assumption (2dp). */
export function bytesToSeconds(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= 0) return 0;
  return Math.round((bytes / MP3_BYTES_PER_SEC) * 100) / 100;
}

export interface PodcastTurn {
  speaker: "A" | "B";
  text: string;
}

export interface PodcastScript {
  title: string;
  turns: PodcastTurn[];
}

// Accept the speaker labels models actually emit ("A", "b", "Host A",
// "HOST B:"…); anything unrecognizable alternates from the curious host.
function normalizeSpeaker(v: unknown, idx: number): "A" | "B" {
  const s = String(v ?? "")
    .replace(/[^a-zA-Z]/g, "")
    .toUpperCase();
  if (s === "A" || s === "HOSTA" || s === "SPEAKERA") return "A";
  if (s === "B" || s === "HOSTB" || s === "SPEAKERB") return "B";
  return idx % 2 === 0 ? "A" : "B";
}

/**
 * Coerce a raw LLM response into a usable script: trim the title, keep only
 * turns with non-empty text, normalize speakers, cap at MAX_TURNS. Throws
 * when nothing speakable survives.
 */
export function validateScript(raw: unknown): PodcastScript {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim() : "";
  const rawTurns = Array.isArray(obj.turns) ? obj.turns : [];
  const turns: PodcastTurn[] = [];
  for (const t of rawTurns) {
    const rec = (t ?? {}) as Record<string, unknown>;
    const text = typeof rec.text === "string" ? rec.text.trim() : "";
    if (!text) continue;
    turns.push({ speaker: normalizeSpeaker(rec.speaker, turns.length), text });
    if (turns.length >= MAX_TURNS) break;
  }
  if (turns.length === 0) throw new Error("Script had no usable turns");
  return { title, turns };
}

// ─── Script writing ─────────────────────────────────────────────────

function titleFromPrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

function scriptSystem(words: number, turns: number): string {
  return [
    "You are writing the full script for a two-host podcast episode.",
    "",
    "The hosts:",
    '- Host A ("A") is the curious host: warm and engaged, frames the topic, asks the questions a smart listener would, reacts genuinely, keeps the show moving.',
    '- Host B ("B") is the expert: deeply knowledgeable, concrete, explains with examples and specifics — vivid, never lecture-y.',
    "",
    "Rules:",
    "- Conversational spoken English: contractions, short sentences, natural handoffs. No stage directions, no sound effects, no markdown — only words to be read aloud.",
    "- A opens by welcoming listeners and framing the topic in a sentence or two; A also closes with a short wrap-up.",
    "- Alternate naturally (A mostly asks and reacts, B carries the substance). Each turn is one host speaking uninterrupted.",
    `- Aim for about ${words} words TOTAL across roughly ${turns} turns (between ${MIN_TURNS} and ${MAX_TURNS} turns).`,
    '- Output JSON exactly: {"title": string (a catchy episode title), "turns": [{"speaker": "A" | "B", "text": string}]}',
  ].join("\n");
}

// Cap the grounding text fed to the script model — a long doc doesn't need
// to be quoted wholesale to produce a few minutes of dialogue.
const SOURCE_CHARS_CAP = 16_000;

// ─── Per-turn synthesis ─────────────────────────────────────────────

/** One ElevenLabs TTS call for one turn, collected to an MP3 Buffer
 *  (same fetch shape + voice settings as generators/tts.ts). */
async function synthesizeTurn(
  text: string,
  voiceId: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_flash_v2_5",
        output_format: "mp3_44100_128",
        voice_settings: TTS_VOICE_SETTINGS,
      }),
      signal,
    },
  );
  if (!res.ok) {
    const errText = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`TTS failed (${res.status}): ${errText}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ─── run() ──────────────────────────────────────────────────────────

async function runPodcast(input: PodcastInput, ctx: GenCtx): Promise<ArtifactSummary> {
  // Narration is the whole product here — refuse before spending on the LLM.
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("voice not configured");

  const model = input.model ?? MODELS.default;
  const voiceA = input.voice_a ? resolveVoiceId(input.voice_a) : PODCAST_VOICE_A;
  const voiceB = input.voice_b ? resolveVoiceId(input.voice_b) : PODCAST_VOICE_B;

  // Resolve the source: a doc artifact's stripped markdown, else the prompt.
  let sourceText: string | undefined;
  let fallbackTitle: string;
  let sourceArtifactId: string | undefined;
  let hubId: string | null = null;
  if (input.artifact_id) {
    const source = getArtifact(input.artifact_id, ctx.userId);
    if (!source) throw new Error("Artifact not found");
    if (source.kind !== "doc") throw new Error("Only doc artifacts can become a podcast");
    const content = fromJson<{ markdown?: string }>(source.content);
    if (!content?.markdown?.trim()) throw new Error("Document has no text to discuss");
    sourceText = stripMarkdown(content.markdown).slice(0, SOURCE_CHARS_CAP);
    fallbackTitle = source.title;
    sourceArtifactId = source.id;
    hubId = source.hub_id;
  } else {
    fallbackTitle = titleFromPrompt(input.prompt ?? "");
  }

  // ── Script ──
  ctx.emit({ type: "status", label: "Writing the script" });
  const budget = turnBudgetForMinutes(input.minutes);
  const raw = await callLLMJSON<PodcastScript>({
    system: scriptSystem(budget.words, budget.turns),
    prompt: [
      sourceText
        ? `Write the episode from this source material:\n\n${sourceText}`
        : `Topic: ${input.prompt?.trim()}`,
      sourceText && input.prompt?.trim() ? `Angle / listener request: ${input.prompt.trim()}` : "",
      `Episode length: about ${input.minutes} minute${input.minutes === 1 ? "" : "s"}.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    model,
    maxTokens: 4000,
  });
  if (ctx.signal.aborted) throw new Error("aborted");

  const script = validateScript(raw);
  const title = script.title || fallbackTitle || "Podcast episode";
  ctx.emit({
    type: "delta",
    channel: "script",
    data: JSON.stringify({ title, turns: script.turns }),
  });

  // ── Narration, turn by turn ──
  const total = script.turns.length;
  const buffers: Buffer[] = [];
  const turnsWithSeek: Array<PodcastTurn & { start_sec: number }> = [];
  let bytesSoFar = 0;
  for (let i = 0; i < total; i++) {
    if (ctx.signal.aborted) throw new Error("aborted");
    const turn = script.turns[i];
    ctx.emit({ type: "status", label: `Narrating turn ${i + 1}/${total}` });
    const buf = await synthesizeTurn(
      turn.text,
      turn.speaker === "A" ? voiceA : voiceB,
      apiKey,
      ctx.signal,
    );
    turnsWithSeek.push({ ...turn, start_sec: bytesToSeconds(bytesSoFar) });
    bytesSoFar += buf.length;
    buffers.push(buf);
  }

  // ── Stitch + persist ──
  ctx.emit({ type: "status", label: "Stitching the episode" });
  const id = uuid();
  const relPath = `artifacts/${id}.mp3`;
  const absPath = join(DATA_DIR, relPath);
  await writeFile(`${absPath}.part`, Buffer.concat(buffers));
  await rename(`${absPath}.part`, absPath);

  const row = insertArtifact({
    id,
    userId: ctx.userId,
    kind: "audio",
    title,
    content: {
      turns: turnsWithSeek,
      voice_a: voiceA,
      voice_b: voiceB,
      duration_sec_estimate: bytesToSeconds(bytesSoFar),
    },
    relPath,
    hubId,
    meta: {
      subtype: "podcast",
      ...(input.prompt?.trim() ? { prompt: input.prompt.trim() } : {}),
      ...(sourceArtifactId ? { source_artifact_id: sourceArtifactId } : {}),
      minutes: input.minutes,
      model,
    },
  });
  return toArtifactSummary(row);
}

export const podcastGenerator: GeneratorService<PodcastInput> = {
  name: "podcast",
  inputSchema: PodcastInputSchema,
  toolDescription:
    "Create a two-host podcast episode (MP3) about a topic or from a doc artifact: a curious host and an expert discuss it in a scripted dialogue narrated with two ElevenLabs voices.",
  run: runPodcast,
  // Audio is terminal — no revise.
};
