// Generator registry: name -> service. Both adapters resolve through here —
// POST /api/generate/:name (P2) and the agent tool auto-wrapper (P3).
import type { GeneratorService } from "./types.js";
import { designGenerator } from "./design.js";
import { docGenerator } from "./doc.js";
import { imageGenerator } from "./image.js";
import { meetingGenerator } from "./meeting.js";
import { podcastGenerator } from "./podcast.js";
import { sheetGenerator } from "./sheet.js";
import { slidesGenerator } from "./slides.js";
import { ttsGenerator } from "./tts.js";
import { webappGenerator } from "./webapp.js";

const GENERATORS: Record<string, GeneratorService<any>> = {
  doc: docGenerator,
  image: imageGenerator,
  meeting: meetingGenerator,
  slides: slidesGenerator,
  tts: ttsGenerator,
  sheet: sheetGenerator,
  podcast: podcastGenerator,
  webapp: webappGenerator,
  design: designGenerator,
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
  slides: "slides",
  audio: "tts",
  sheet: "sheet",
  webpage: "webapp",
};

export function getGeneratorForKind(kind: string): GeneratorService<any> | undefined {
  const name = GENERATOR_NAME_BY_KIND[kind];
  return name ? GENERATORS[name] : undefined;
}
