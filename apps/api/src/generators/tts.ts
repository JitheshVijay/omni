// TTS generator: text (or a doc artifact's markdown, stripped) -> chunked
// ElevenLabs narration -> concatenated MP3 at artifacts/<id>.mp3 + artifact
// row (kind 'audio', content {voice_id, text_chars}).
//
// Chunks split at sentence boundaries around ~2500 chars; each chunk is one
// ElevenLabs call collected to a Buffer, and the mp3_44100_128 frames are
// naively concatenated (valid enough for every mainstream player). Audio
// artifacts are terminal — no revise().
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { env } from "@omni/env-config";
import { DATA_DIR, fromJson, uuid } from "@omni/sdk";
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

const TtsInputSchema = z
  .object({
    text: z.string().max(20000).optional(),
    artifact_id: z.string().optional(),
    voice_id: z.string().optional(),
  })
  .refine((d) => (d.text?.trim() ? 1 : 0) + (d.artifact_id ? 1 : 0) === 1, {
    message: "Provide exactly one of text or artifact_id",
  });

export type TtsInput = z.infer<typeof TtsInputSchema>;

const CHUNK_CHARS = 2500;

/**
 * Split text into ~maxLen-char chunks at sentence boundaries. Sentences
 * longer than maxLen are hard-split so no chunk ever exceeds the cap.
 */
export function chunkSentences(text: string, maxLen = CHUNK_CHARS): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > maxLen) {
      flush();
      for (let i = 0; i < sentence.length; i += maxLen) {
        chunks.push(sentence.slice(i, i + maxLen).trim());
      }
      continue;
    }
    if (current && current.length + 1 + sentence.length > maxLen) flush();
    current = current ? `${current} ${sentence}` : sentence;
  }
  flush();
  return chunks.filter((c) => c.length > 0);
}

/** One ElevenLabs TTS call, collected to an MP3 Buffer. */
async function synthesizeChunk(
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

async function runTts(input: TtsInput, ctx: GenCtx): Promise<ArtifactSummary> {
  const apiKey = env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error("voice not configured");

  // Resolve the narration text: raw input, or a doc artifact's markdown
  // stripped down to speakable prose.
  let text: string;
  let title: string;
  let sourceArtifactId: string | undefined;
  let hubId: string | null = null;
  if (input.artifact_id) {
    const source = getArtifact(input.artifact_id, ctx.userId);
    if (!source) throw new Error("Artifact not found");
    if (source.kind !== "doc") throw new Error("Only doc artifacts can be narrated");
    const content = fromJson<{ markdown?: string }>(source.content);
    if (!content?.markdown?.trim()) throw new Error("Document has no text to narrate");
    text = stripMarkdown(content.markdown);
    title = source.title;
    sourceArtifactId = source.id;
    hubId = source.hub_id;
  } else {
    text = (input.text ?? "").trim();
    title = text.replace(/\s+/g, " ").slice(0, 80);
  }
  if (!text.trim()) throw new Error("Nothing to narrate");

  const voiceId = resolveVoiceId(input.voice_id);
  const chunks = chunkSentences(text);
  const buffers: Buffer[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (ctx.signal.aborted) throw new Error("aborted");
    ctx.emit({ type: "status", label: `Narrating chunk ${i + 1}/${chunks.length}` });
    buffers.push(await synthesizeChunk(chunks[i], voiceId, apiKey, ctx.signal));
  }

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
    content: { voice_id: voiceId, text_chars: text.length },
    relPath,
    hubId,
    meta: {
      voice_id: voiceId,
      ...(sourceArtifactId ? { source_artifact_id: sourceArtifactId } : {}),
    },
  });
  return toArtifactSummary(row);
}

export const ttsGenerator: GeneratorService<TtsInput> = {
  name: "tts",
  inputSchema: TtsInputSchema,
  toolDescription:
    "Narrate text or a doc artifact to speech (MP3) with a selectable ElevenLabs voice.",
  run: runTts,
  // Audio is terminal — no revise.
};
