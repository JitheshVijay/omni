// Composer dictation: multipart audio in, ElevenLabs Scribe STT, text out.
// Raw fetch (no SDK), mirroring Flo101's flo.ts transcribe endpoint.
import type { FastifyInstance } from "fastify";
import { env } from "@omni/env-config";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

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
}
