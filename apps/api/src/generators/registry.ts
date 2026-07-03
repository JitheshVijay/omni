// Generator registry: name -> service. Both adapters resolve through here —
// POST /api/generate/:name (P2) and the agent tool auto-wrapper (P3).
import type { GeneratorService } from "./types.js";
import { docGenerator } from "./doc.js";
import { imageGenerator } from "./image.js";
import { ttsGenerator } from "./tts.js";

const GENERATORS: Record<string, GeneratorService<any>> = {
  doc: docGenerator,
  image: imageGenerator,
  tts: ttsGenerator,
};

export function getGenerator(name: string): GeneratorService<any> | undefined {
  return GENERATORS[name];
}

export function listGenerators(): GeneratorService<any>[] {
  return Object.values(GENERATORS);
}

// Which generator revises which artifact kind. 'audio' maps to tts, which
// exposes no revise() — the revise route turns that into a 400.
const GENERATOR_NAME_BY_KIND: Record<string, string> = {
  doc: "doc",
  image: "image",
  audio: "tts",
};

export function getGeneratorForKind(kind: string): GeneratorService<any> | undefined {
  const name = GENERATOR_NAME_BY_KIND[kind];
  return name ? GENERATORS[name] : undefined;
}
