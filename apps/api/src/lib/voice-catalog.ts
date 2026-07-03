// Curated ElevenLabs voice catalog, adapted from Flo101's voice-catalog.ts.
// Shared by GET /api/voice/voices, POST /api/voice/tts, and the tts
// generator. `id` is the raw ElevenLabs voice_id — that's what clients
// store and send back, so no slug indirection here. All entries render
// English well on eleven_flash_v2_5.

export interface VoiceCatalogEntry {
  id: string;
  name: string;
  description: string;
}

export const VOICE_CATALOG: VoiceCatalogEntry[] = [
  { id: "XrExE9yKIg1WjnnlVkGX", name: "Matilda", description: "Warm, friendly narrator" },
  { id: "cgSgspJ2msm6clMCkdW9", name: "Hope", description: "Bright, encouraging" },
  { id: "EXAVITQu4vr4xnSDxMaL", name: "Alexandra", description: "Friendly, curious" },
  { id: "VR6AewLTigWG4xSOukaG", name: "Arnold", description: "Crisp, technical" },
  { id: "iP95p4xoKVk53GoZ742B", name: "Chris", description: "Casual, conversational" },
  { id: "Xb7hH8MSUJpSbSDYk0k2", name: "Alice", description: "Polished British" },
  { id: "onwK4e9ZLuTAKqWW03F9", name: "Daniel", description: "Authoritative British" },
  { id: "IKne3meq5aSn9XLyUdCD", name: "Archer", description: "Charming, collaborative" },
];

export const DEFAULT_VOICE_ID: string = VOICE_CATALOG[0].id; // Matilda

// TTS delivery settings shared by every ElevenLabs call. High stability +
// style:0 keeps the read calm and even — lower values spike into an
// over-excited, sing-song delivery.
export const TTS_VOICE_SETTINGS = {
  stability: 0.82,
  similarity_boost: 0.75,
  style: 0,
  use_speaker_boost: false,
} as const;

/**
 * Resolve loose input to an ElevenLabs voice_id: raw ids pass through,
 * catalog names match case-insensitively, anything else falls back to the
 * default voice.
 */
export function resolveVoiceId(input: string | null | undefined): string {
  const trimmed = input?.trim();
  if (!trimmed) return DEFAULT_VOICE_ID;
  // ElevenLabs voice ids are ~20-char alphanumeric — trust the shape.
  if (/^[a-zA-Z0-9]{18,24}$/.test(trimmed)) return trimmed;
  const hit = VOICE_CATALOG.find((v) => v.name.toLowerCase() === trimmed.toLowerCase());
  return hit?.id ?? DEFAULT_VOICE_ID;
}
