// Voice endpoints, all raw fetch (no SDK) against ElevenLabs:
//   POST /api/voice/transcribe — composer dictation (Scribe STT)
//   GET  /api/voice/voices     — curated voice catalog + configured flag
//   POST /api/voice/tts        — short-text TTS proxy, streamed audio/mpeg
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { env } from "@omni/env-config";
import {
  DEFAULT_VOICE_ID,
  TTS_VOICE_SETTINGS,
  VOICE_CATALOG,
} from "../lib/voice-catalog.js";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const TtsBodySchema = z.object({
  text: z.string().min(1).max(4000),
  voice_id: z.string().optional(),
});

export async function voiceRoutes(app: FastifyInstance) {
  // ── POST /api/voice/transcribe ──
  app.post("/api/voice/transcribe", async (request, reply) => {
    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return reply.status(400).send({
        success: false,
        error: "voice not configured",
        code: "voice_unconfigured",
      });
    }

    let buffer: Buffer;
    let mimetype: string;
    let filename: string;
    try {
      const part = await request.file();
      if (!part) {
        return reply
          .status(400)
          .send({ success: false, error: "No audio uploaded", code: "no_file" });
      }
      buffer = await part.toBuffer();
      mimetype = part.mimetype || "audio/webm";
      filename = part.filename || "audio.webm";
    } catch (err) {
      request.log.warn({ err }, "[voice] multipart read failed");
      return reply
        .status(400)
        .send({ success: false, error: "Malformed upload", code: "bad_upload" });
    }
    if (buffer.length === 0) {
      return reply
        .status(400)
        .send({ success: false, error: "Empty audio", code: "empty_file" });
    }
    if (buffer.length > MAX_AUDIO_BYTES) {
      return reply
        .status(413)
        .send({ success: false, error: "Audio too large (max 20MB)", code: "too_large" });
    }

    try {
      const form = new FormData();
      // Re-wrap as Uint8Array: Node's Blob typing rejects Buffer's
      // ArrayBufferLike generic under strict TS; the copy view is free.
      const blob = new Blob([new Uint8Array(buffer)], { type: mimetype });
      form.append("file", blob, filename);
      form.append("model_id", "scribe_v1");
      const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) {
        const errText = (await res.text()).slice(0, 200);
        request.log.error(
          { status: res.status, body: errText },
          "[voice] elevenlabs STT failed",
        );
        return reply.status(502).send({
          success: false,
          error: `Transcription failed (${res.status})`,
          code: "stt_failed",
        });
      }
      const data = (await res.json()) as { text?: string };
      const text = (data.text ?? "").trim();
      if (!text) {
        return reply.status(422).send({
          success: false,
          error: "Couldn't make out any speech. Try again?",
          code: "no_speech",
        });
      }
      return { success: true, data: { text } };
    } catch (err) {
      const message = (err as Error).message?.slice(0, 200) ?? "transcription failed";
      request.log.error({ err: message }, "[voice] transcribe threw");
      return reply
        .status(502)
        .send({ success: false, error: message, code: "stt_failed" });
    }
  });

  // ── GET /api/voice/voices ──
  // Curated catalog; configured=false + empty list when the key is unset so
  // the UI can hide/disable voice features instead of failing calls.
  app.get("/api/voice/voices", async () => {
    const configured = Boolean(env.ELEVENLABS_API_KEY);
    return {
      success: true,
      data: {
        configured,
        voices: configured
          ? VOICE_CATALOG.map((v) => ({
              id: v.id,
              name: v.name,
              description: v.description,
            }))
          : [],
      },
    };
  });

  // ── POST /api/voice/tts ──
  // NOT SSE: proxies ElevenLabs streaming TTS straight through as an
  // audio/mpeg body (Flo101 buddy.ts pattern) — the first MP3 chunk reaches
  // the client while ElevenLabs is still synthesizing the tail.
  app.post("/api/voice/tts", async (request, reply) => {
    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return reply.status(400).send({
        success: false,
        error: "voice not configured",
        code: "voice_unconfigured",
      });
    }
    const parsed = TtsBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const voiceId = parsed.data.voice_id ?? DEFAULT_VOICE_ID;

    try {
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
            text: parsed.data.text,
            model_id: "eleven_flash_v2_5",
            output_format: "mp3_44100_128",
            voice_settings: TTS_VOICE_SETTINGS,
          }),
          signal: AbortSignal.timeout(120_000),
        },
      );
      if (!res.ok) {
        const errText = (await res.text().catch(() => "")).slice(0, 200);
        request.log.error(
          { status: res.status, body: errText },
          "[voice] elevenlabs TTS failed",
        );
        return reply.status(502).send({
          success: false,
          error: `TTS failed (${res.status})`,
          code: "tts_failed",
        });
      }
      if (!res.body) {
        return reply
          .status(502)
          .send({ success: false, error: "TTS empty response", code: "tts_failed" });
      }

      // Writing to reply.raw hijacks the response, which bypasses the CORS
      // plugin's onSend hook — mirror the allow-origin headers manually.
      const raw = reply.raw;
      const origin = request.headers.origin;
      if (origin) {
        raw.setHeader("Access-Control-Allow-Origin", origin);
        raw.setHeader("Vary", "Origin");
        raw.setHeader("Access-Control-Allow-Credentials", "true");
      }
      raw.setHeader("Content-Type", "audio/mpeg");
      raw.setHeader("Cache-Control", "no-store");

      // Pipe Web ReadableStream -> Node response with backpressure so slow
      // client connections don't balloon memory.
      const reader = res.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (!raw.write(Buffer.from(value))) {
            await new Promise<void>((resolve) => raw.once("drain", () => resolve()));
          }
        }
      } finally {
        try {
          raw.end();
        } catch {
          /* already ended */
        }
      }
      return reply;
    } catch (err) {
      const message = (err as Error).message?.slice(0, 200) ?? "tts failed";
      request.log.error({ err: message }, "[voice] tts threw");
      // Only send a JSON error if we haven't started streaming yet.
      if (!reply.raw.headersSent) {
        return reply
          .status(502)
          .send({ success: false, error: "TTS failed", code: "tts_failed" });
      }
      try {
        reply.raw.end();
      } catch {
        /* already ended */
      }
      return reply;
    }
  });
}
