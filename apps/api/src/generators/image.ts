// Image generator: prompt -> Gemini image via OpenRouter -> PNG blob at
// artifacts/<id>.png + artifact row (kind 'image', content null).
//
// Edit-by-prompt: when parent_artifact_id is set, the parent's blob rides
// along as a data-URL image_url part and the prompt becomes the edit
// instruction; the new artifact records parent_id lineage. revise() is the
// same path with the instruction as the prompt.
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  DATA_DIR,
  MODELS,
  fromJson,
  generateImageBytes,
  uuid,
  type SourceImage,
} from "@omni/sdk";
import {
  getArtifact,
  insertArtifact,
  toArtifactSummary,
  type ArtifactSummary,
  type GenCtx,
  type GeneratorService,
} from "./types.js";

const ASPECT_RATIOS = ["1:1", "16:9", "9:16", "4:3", "3:4"] as const;

const ImageInputSchema = z.object({
  prompt: z.string().min(1).max(2000),
  aspect_ratio: z.enum(ASPECT_RATIOS).default("1:1"),
  // When set: edit-by-prompt of that image artifact.
  parent_artifact_id: z.string().optional(),
});

export type ImageInput = z.infer<typeof ImageInputSchema>;

function titleFromPrompt(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

async function runImage(input: ImageInput, ctx: GenCtx): Promise<ArtifactSummary> {
  // Edit path: load the parent's blob as a data URL.
  let sourceImage: SourceImage | undefined;
  if (input.parent_artifact_id) {
    const parent = getArtifact(input.parent_artifact_id, ctx.userId);
    if (!parent) throw new Error("Parent artifact not found");
    if (parent.kind !== "image" || !parent.rel_path) {
      throw new Error("Parent artifact is not an image");
    }
    const bytes = await readFile(join(DATA_DIR, parent.rel_path));
    sourceImage = { dataUrl: `data:image/png;base64,${bytes.toString("base64")}` };
  }

  ctx.emit({ type: "status", label: "Painting" });

  // Gemini image via OpenRouter has no size param — the aspect hint rides
  // in the prompt text instead.
  const prompt = `${input.prompt.trim()}\n\nAspect ratio: ${input.aspect_ratio}.`;
  const bytes = await generateImageBytes(prompt, sourceImage, ctx.signal);
  if (ctx.signal.aborted) throw new Error("aborted");

  // Blob first (atomic .part -> rename), row second — a crash never leaves
  // a row pointing at a missing blob.
  const id = uuid();
  const relPath = `artifacts/${id}.png`;
  const absPath = join(DATA_DIR, relPath);
  await writeFile(`${absPath}.part`, bytes);
  await rename(`${absPath}.part`, absPath);

  const row = insertArtifact({
    id,
    userId: ctx.userId,
    kind: "image",
    title: titleFromPrompt(input.prompt),
    relPath,
    parentId: input.parent_artifact_id ?? null,
    meta: {
      prompt: input.prompt,
      model: MODELS.image_gen,
      aspect_ratio: input.aspect_ratio,
    },
  });
  return toArtifactSummary(row);
}

async function reviseImage(
  artifactId: string,
  instruction: string,
  ctx: GenCtx,
): Promise<ArtifactSummary> {
  // Carry the parent's aspect ratio through the edit; runImage validates
  // ownership + kind and records the lineage.
  const parent = getArtifact(artifactId, ctx.userId);
  if (!parent) throw new Error("Artifact not found");
  const meta = fromJson<{ aspect_ratio?: string }>(parent.meta);
  const aspect = ASPECT_RATIOS.find((a) => a === meta?.aspect_ratio) ?? "1:1";
  return runImage(
    { prompt: instruction, aspect_ratio: aspect, parent_artifact_id: artifactId },
    ctx,
  );
}

export const imageGenerator: GeneratorService<ImageInput> = {
  name: "image",
  inputSchema: ImageInputSchema,
  toolDescription:
    "Generate an image from a text prompt (or edit an existing image artifact by prompt when parent_artifact_id is set).",
  run: runImage,
  revise: reviseImage,
};
