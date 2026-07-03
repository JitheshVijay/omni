// Paragraph-primary text chunker for hub memory ingestion.
//
// Targets ~1200-char chunks (min 400, max 2000): paragraphs are merged until
// the target is reached; oversized paragraphs are split at sentence/space
// boundaries; a trailing runt is merged back into its predecessor. Page-aware
// input keeps chunks within page boundaries so "[Page N]" cite labels stay
// truthful; flat text gets sequential "[Part N]" labels.
import { createHash } from "node:crypto";

export interface ChunkInputPage {
  text: string;
  pageNumber: number;
}

export type ChunkInput = { pages: ChunkInputPage[] } | { flatText: string };

export interface TextChunk {
  chunk_text: string;
  cite_label: string;
  section_title?: string;
  chunk_idx: number;
  content_hash: string;
}

const TARGET_CHARS = 1200;
const MIN_CHARS = 400;
const MAX_CHARS = 2000;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Split an oversized block at sentence/space boundaries near TARGET_CHARS. */
function splitLongBlock(block: string): string[] {
  const out: string[] = [];
  let rest = block;
  while (rest.length > MAX_CHARS) {
    const window = rest.slice(0, MAX_CHARS);
    // Prefer a sentence end after the target, then a newline, then a space.
    let cut = -1;
    const sentence = window.slice(TARGET_CHARS).search(/[.!?]\s/);
    if (sentence >= 0) cut = TARGET_CHARS + sentence + 1;
    if (cut < 0) {
      const nl = window.lastIndexOf("\n");
      if (nl >= MIN_CHARS) cut = nl;
    }
    if (cut < 0) {
      const sp = window.lastIndexOf(" ");
      if (sp >= MIN_CHARS) cut = sp;
    }
    if (cut < 0) cut = TARGET_CHARS;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

interface SectionedText {
  text: string;
  sectionTitle?: string;
}

/**
 * Chunk one contiguous text (a page, or the whole flat doc). Tracks markdown
 * headings as section titles for the chunks that follow them.
 */
function chunkOneText(text: string): SectionedText[] {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const out: SectionedText[] = [];
  let current = "";
  let currentSection: string | undefined;
  let pendingSection: string | undefined;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0) out.push({ text: trimmed, sectionTitle: currentSection });
    current = "";
  };

  for (const para of paragraphs) {
    // A markdown heading names the section for subsequent chunks.
    const heading = /^#{1,6}\s+(.+)$/m.exec(para.split("\n")[0] ?? "");
    if (heading) pendingSection = heading[1].trim().slice(0, 200);

    const blocks = para.length > MAX_CHARS ? splitLongBlock(para) : [para];
    for (const block of blocks) {
      if (current.length === 0) {
        currentSection = pendingSection;
        current = block;
      } else if (current.length + 2 + block.length <= MAX_CHARS && current.length < TARGET_CHARS) {
        current += `\n\n${block}`;
      } else {
        flush();
        currentSection = pendingSection;
        current = block;
      }
      if (current.length >= TARGET_CHARS) flush();
    }
  }
  flush();

  // Merge a trailing runt into its predecessor when the pair still fits.
  if (out.length >= 2) {
    const last = out[out.length - 1];
    const prev = out[out.length - 2];
    if (last.text.length < MIN_CHARS && prev.text.length + 2 + last.text.length <= MAX_CHARS) {
      prev.text = `${prev.text}\n\n${last.text}`;
      out.pop();
    }
  }
  return out;
}

/**
 * Chunk page-aware or flat text into cite-labeled chunks. chunk_idx is a
 * single 0-based sequence across the whole document (matches the
 * UNIQUE(hub_id, file_id, chunk_idx) upsert key).
 */
export function chunkText(input: ChunkInput): TextChunk[] {
  const chunks: TextChunk[] = [];
  let idx = 0;

  if ("pages" in input) {
    for (const page of input.pages) {
      for (const piece of chunkOneText(page.text)) {
        chunks.push({
          chunk_text: piece.text,
          cite_label: `[Page ${page.pageNumber}]`,
          ...(piece.sectionTitle ? { section_title: piece.sectionTitle } : {}),
          chunk_idx: idx++,
          content_hash: sha256(piece.text),
        });
      }
    }
    return chunks;
  }

  let part = 1;
  for (const piece of chunkOneText(input.flatText)) {
    chunks.push({
      chunk_text: piece.text,
      cite_label: `[Part ${part++}]`,
      ...(piece.sectionTitle ? { section_title: piece.sectionTitle } : {}),
      chunk_idx: idx++,
      content_hash: sha256(piece.text),
    });
  }
  return chunks;
}
