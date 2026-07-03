// Multi-format text extraction for the Drive indexer. Adapted from Flo101's
// lib/pdf-extract.ts. Routes by mime/extension:
//   - PDF  -> LlamaParse (when LLAMAPARSE_API_KEY is set; layout-aware
//             markdown pages) with pdf-parse as the local fallback,
//   - DOCX -> mammoth (flat text),
//   - text/* | json | md | csv | yaml | code -> utf8 read,
//   - anything else -> null (caller marks the file `skipped`).
// All extracted text is stripped of NUL/C0/C1 control chars before storage.
import { readFile } from "node:fs/promises";
import { env } from "@omni/env-config";
import { logger } from "@omni/sdk";
import mammoth from "mammoth";

export interface ExtractedPage {
  text: string;
  pageNumber: number;
}

export type ExtractResult =
  | { pages: ExtractedPage[] }
  | { flatText: string }
  | null;

// Cap pathological flat-text inputs (a 20MB log file would otherwise fan out
// into tens of thousands of embedding calls).
const MAX_FLAT_TEXT_CHARS = 800_000;

// ───────── control-char scrub ─────────

function stripControlChars(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13) {
      out += s[i];
      continue;
    }
    if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) continue;
    out += s[i];
  }
  return out;
}

function sanitizePages(pages: ExtractedPage[]): ExtractedPage[] {
  return pages
    .map((p) => ({ ...p, text: stripControlChars(p.text ?? "").trim() }))
    .filter((p) => p.text.length > 0);
}

// ───────── pdf-parse fallback ─────────

interface ParserCtor {
  new (opts: { data: Uint8Array }): {
    load(): Promise<void>;
    getText(): Promise<{ pages?: Array<{ text?: string }> }>;
    destroy?: () => void;
  };
}

async function getPdfParseClass(): Promise<ParserCtor> {
  // pdf-parse's PDFParse has private members; cast through unknown to the
  // public structural surface we use.
  const mod = (await import("pdf-parse")) as unknown as { PDFParse: ParserCtor };
  return mod.PDFParse;
}

async function extractPdfPagesWithPdfParse(buffer: Buffer): Promise<ExtractedPage[]> {
  const PDFParse = await getPdfParseClass();
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    await parser.load();
  } catch (err) {
    const e = err as { name?: string; message?: string };
    if (e?.name === "PasswordException" || /password/i.test(e?.message ?? "")) {
      throw new Error("PDF is password-protected; upload an unprotected copy.", {
        cause: err,
      });
    }
    throw err;
  }
  let raw: Array<{ text?: string }>;
  try {
    const result = await parser.getText();
    raw = result?.pages ?? [];
  } catch {
    raw = [];
  }
  try {
    parser.destroy?.();
  } catch {
    /* best-effort cleanup */
  }
  return raw.map((p, i) => ({
    text: (p?.text ?? "").replace(/\r\n/g, "\n"),
    pageNumber: i + 1,
  }));
}

// ───────── LlamaParse primary ─────────

const LLAMAPARSE_BASE = "https://api.cloud.llamaindex.ai";
// Agentic-tier conversions run 60-150s on meaty PDFs; 180s gives headroom.
const LLAMAPARSE_POLL_TIMEOUT_MS = 180_000;
const LLAMAPARSE_POLL_INTERVAL_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function extractPagesWithLlamaParse(
  buffer: Buffer,
  apiKey: string,
  tier: string,
  mimeType: string,
  filename: string,
): Promise<ExtractedPage[] | null> {
  try {
    // 1) Upload via multipart. Field name MUST be `file`; purpose=extract is
    //    required for parse jobs.
    const uploadForm = new FormData();
    uploadForm.append(
      "file",
      new Blob([new Uint8Array(buffer)], { type: mimeType }),
      filename,
    );
    uploadForm.append("purpose", "extract");
    const uploadRes = await fetch(`${LLAMAPARSE_BASE}/api/v1/beta/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: uploadForm,
      signal: AbortSignal.timeout(30_000),
    });
    if (!uploadRes.ok) {
      logger.warn(
        { status: uploadRes.status, body: (await uploadRes.text()).slice(0, 300) },
        "[extract-text] llamaparse upload non-2xx",
      );
      return null;
    }
    const uploadData = (await uploadRes.json()) as { id?: string };
    if (!uploadData.id) return null;

    // 2) Create the parse job. `version: "latest"` is required by /api/v2/parse.
    const parseRes = await fetch(`${LLAMAPARSE_BASE}/api/v2/parse`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ file_id: uploadData.id, tier, version: "latest" }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!parseRes.ok) {
      logger.warn(
        { status: parseRes.status, body: (await parseRes.text()).slice(0, 300) },
        "[extract-text] llamaparse parse create non-2xx",
      );
      return null;
    }
    const parseData = (await parseRes.json()) as { job?: { id?: string }; id?: string };
    const jobId = parseData.job?.id ?? parseData.id;
    if (!jobId) return null;

    // 3) Poll until SUCCESS/ERROR/timeout. Status lives under .job.status;
    //    expand=markdown inlines the result once done.
    const deadline = Date.now() + LLAMAPARSE_POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(LLAMAPARSE_POLL_INTERVAL_MS);
      const pollRes = await fetch(
        `${LLAMAPARSE_BASE}/api/v2/parse/${jobId}?expand=markdown`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: AbortSignal.timeout(15_000),
        },
      );
      if (!pollRes.ok) continue;
      const pollData = (await pollRes.json()) as {
        job?: { status?: string; error_message?: string };
        markdown?: { pages?: Array<{ page_number?: number; markdown?: string }> };
      };
      const status = (pollData.job?.status ?? "").toUpperCase();
      if (status === "SUCCESS" || status === "COMPLETED") {
        const pages = pollData.markdown?.pages ?? [];
        if (pages.length === 0) return null;
        return pages
          .map((p, i) => ({
            text: (p.markdown ?? "").trim(),
            pageNumber: p.page_number ?? i + 1,
          }))
          .filter((p) => p.text.length > 0);
      }
      if (status === "ERROR" || status === "FAILED" || status === "CANCELLED") {
        logger.warn(
          { jobId, error: pollData.job?.error_message },
          "[extract-text] llamaparse job failed",
        );
        return null;
      }
    }
    logger.warn({ jobId }, "[extract-text] llamaparse poll timeout");
    return null;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message?.slice(0, 200) ?? String(err) },
      "[extract-text] llamaparse threw; falling back",
    );
    return null;
  }
}

// ───────── format routing ─────────

const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/javascript",
  "application/typescript",
  "application/x-ndjson",
  "application/sql",
]);

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson", "xml",
  "yaml", "yml", "html", "htm", "log", "ts", "tsx", "js", "jsx", "py", "rb",
  "go", "rs", "java", "c", "h", "cpp", "sql", "sh", "toml", "ini", "css",
]);

function extOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/**
 * Extract text from a Drive blob. Returns page-aware pages for PDFs,
 * flat text for docx/plain formats, and null for unsupported binaries
 * (the caller marks the file `skipped`).
 */
export async function extractText(
  absPath: string,
  mime: string,
  name: string,
): Promise<ExtractResult> {
  const ext = extOf(name);
  const lowerMime = (mime || "").toLowerCase().split(";")[0].trim();

  // ── PDF ──
  if (lowerMime === "application/pdf" || ext === "pdf") {
    const buffer = await readFile(absPath);
    if (env.LLAMAPARSE_API_KEY) {
      const pages = await extractPagesWithLlamaParse(
        buffer,
        env.LLAMAPARSE_API_KEY,
        env.LLAMAPARSE_TIER,
        "application/pdf",
        name || "document.pdf",
      );
      if (pages !== null) return { pages: sanitizePages(pages) };
    }
    return { pages: sanitizePages(await extractPdfPagesWithPdfParse(buffer)) };
  }

  // ── DOCX ──
  if (lowerMime === DOCX_MIME || ext === "docx") {
    const buffer = await readFile(absPath);
    const result = await mammoth.extractRawText({ buffer });
    const text = stripControlChars(result.value ?? "").trim();
    if (!text) return { flatText: "" };
    return { flatText: text.slice(0, MAX_FLAT_TEXT_CHARS) };
  }

  // ── plain text-ish ──
  if (
    lowerMime.startsWith("text/") ||
    TEXT_MIMES.has(lowerMime) ||
    TEXT_EXTENSIONS.has(ext)
  ) {
    const raw = await readFile(absPath, "utf8");
    return { flatText: stripControlChars(raw).trim().slice(0, MAX_FLAT_TEXT_CHARS) };
  }

  // Unsupported binary (images, audio, archives...) — caller marks skipped.
  return null;
}
