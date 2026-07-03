// Generative image helper, ported from Flo101's image-gen.ts. Gemini-class
// models only (MODELS.image_gen): OpenRouter's /chat/completions with
// modalities: ["image","text"] returns the image as base64 — usually in
// message.images[0].image_url.url, but all three observed response shapes
// are handled. When `sourceImage` is provided the call becomes an
// edit-by-prompt: the source image rides along as an image_url content part
// and the prompt is the edit instruction (verified wire shape).
//
// Traced in LangSmith only when LANGSMITH_TRACING === "true" (same gating
// as llm.ts); processOutputs omits the returned bytes so a trace records
// the prompt + timing, not megabytes of base64.

import { env } from "@omni/env-config";
import { traceable } from "langsmith/traceable";
import { MODELS } from "../ai/models.js";

const tracingEnabled = env.LANGSMITH_TRACING === "true";

export interface SourceImage {
  /** data:image/...;base64,... URL of the image to edit. */
  dataUrl: string;
}

// Structural response shape — loose on purpose, the fallbacks below probe it.
interface ImageGenResponse {
  choices?: Array<{
    message?: {
      content?: string | Array<{ type?: string; image_url?: { url?: string } }>;
      images?: Array<{ image_url?: { url?: string } }>;
    };
  }>;
}

function stripDataUrlPrefix(url: string): string {
  return url.replace(/^data:image\/\w+;base64,/, "");
}

async function generateImageBytesImpl(
  prompt: string,
  sourceImage?: SourceImage,
  signal?: AbortSignal,
): Promise<Buffer> {
  const apiKey = env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY missing — can't generate image.");

  // Edit-by-prompt: the source image is an image_url part next to the text
  // instruction. Plain generation sends the prompt string directly.
  const content = sourceImage
    ? [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: sourceImage.dataUrl } },
      ]
    : prompt;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MODELS.image_gen,
      messages: [{ role: "user", content }],
      modalities: ["image", "text"],
    }),
    signal: signal ?? AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`image gen failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as ImageGenResponse;
  const choice = data.choices?.[0]?.message;

  // Shape 1: content is itself a data URL string.
  let b64: string | null = null;
  if (typeof choice?.content === "string" && choice.content.startsWith("data:image")) {
    b64 = stripDataUrlPrefix(choice.content);
  }
  // Shape 2 (the common Gemini shape): message.images[0].image_url.url.
  if (!b64 && Array.isArray(choice?.images)) {
    const imgUrl = choice.images[0]?.image_url?.url;
    if (imgUrl?.startsWith("data:image")) {
      b64 = stripDataUrlPrefix(imgUrl);
    }
  }
  // Shape 3: content is a parts array with an image_url part.
  if (!b64 && Array.isArray(choice?.content)) {
    for (const part of choice.content) {
      if (part.type === "image_url" && part.image_url?.url?.startsWith("data:image")) {
        b64 = stripDataUrlPrefix(part.image_url.url);
        break;
      }
    }
  }
  if (!b64) throw new Error("Gemini image gen: no image data in response");
  return Buffer.from(b64, "base64");
}

/**
 * Generate (or edit, when `sourceImage` is set) an image via OpenRouter's
 * Gemini image path. Returns raw image bytes (PNG in practice).
 */
export const generateImageBytes: (
  prompt: string,
  sourceImage?: SourceImage,
  signal?: AbortSignal,
) => Promise<Buffer> = tracingEnabled
  ? (traceable(generateImageBytesImpl, {
      name: "generateImageBytes",
      run_type: "llm",
      processOutputs: () => ({ image: "<bytes omitted from trace>" }),
    }) as unknown as typeof generateImageBytesImpl)
  : generateImageBytesImpl;
