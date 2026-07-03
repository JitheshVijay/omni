// Shared API payload types for @omni/web. These mirror the SQLite schema in
// /migrations/*.sql and the API envelope conventions ({success:true, data}).
// The `data` payload shapes below are the web app's single source of truth —
// if the API returns a different wrapper, reconcile here.

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cost_usd: number;
  model: string;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
}

export interface UsageTotals {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

export interface ChatThread {
  id: string;
  user_id: string;
  hub_id: string | null;
  title: string;
  model: string;
  usage_totals: UsageTotals | string;
  created_at: string;
  updated_at: string;
}

export interface Citation {
  chunk_id: string;
  file_id: string | null;
  cite_label: string;
  score: number;
  snippet?: string;
}

export interface ChatAttachment {
  file_id: string;
  name: string;
  mime: string;
}

export interface ChatMessage {
  id: string;
  thread_id: string;
  user_id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  model: string | null;
  usage: TokenUsage | string | null;
  tool_calls: unknown;
  attachments: ChatAttachment[] | string | null;
  citations: Citation[] | string | null;
  error: string | null;
  created_at: string;
}

export interface Hub {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  default_model: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  // Counts included by GET /api/hubs.
  file_count?: number;
  thread_count?: number;
}

export type IndexStatus =
  | "pending"
  | "extracting"
  | "embedding"
  | "ready"
  | "failed"
  | "skipped";

export interface DriveFile {
  id: string;
  user_id: string;
  name: string;
  mime: string;
  size_bytes: number;
  rel_path: string;
  origin: "upload" | "generated" | "url";
  index_status: IndexStatus;
  index_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ModelInfo {
  id: string;
  label: string;
  provider: string;
  context: number;
  supportsVision: boolean;
  supportsTools: boolean;
  pricingHint: string;
  // Set by GET /api/models (curated registry ∩ live OpenRouter list).
  available?: boolean;
}

export interface MemorySearchResult {
  id: string;
  chunk_id?: string;
  hub_id: string;
  file_id: string | null;
  file_name?: string | null;
  kind: "file" | "chat" | "note";
  chunk_text: string;
  cite_label: string;
  section_title: string | null;
  score: number;
}

export interface AgentRun {
  id: string;
  title: string | null;
  goal: string;
  status:
    | "queued"
    | "planning"
    | "running"
    | "awaiting_confirmation"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled";
  model: string | null;
  cost_usd: number;
  created_at: string;
  finished_at: string | null;
}

// ── Generators & artifacts (Phase 2) ────────────────────────────────────

export type ArtifactKind = "doc" | "image" | "audio";

// Returned by list endpoints and SSE `artifact` events — never carries
// `content` (docs can be large; fetch the detail endpoint for it).
export interface ArtifactSummary {
  id: string;
  kind: ArtifactKind | string;
  title: string;
  rel_path: string | null;
  parent_id: string | null;
  hub_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
}

// One numbered hub-memory source cited by a generated doc. `idx` matches the
// [[cite:IDX:LABEL]] tokens embedded in the markdown.
export interface DocSource {
  idx: number;
  label: string;
  file_id: string | null;
  snippet: string;
}

// artifacts.content for kind='doc'. `blocks` is null until the editor first
// saves; `markdown` is ALWAYS kept in sync (it is the export + TTS source).
export interface DocContent {
  markdown: string;
  blocks?: unknown[] | null;
  sources: DocSource[];
}

// artifacts.content for kind='audio'.
export interface AudioContent {
  voice_id: string;
  text_chars: number;
}

// GET /api/artifacts/:id — flat artifact with content/meta JSON-parsed.
export interface Artifact extends ArtifactSummary {
  content: DocContent | AudioContent | Record<string, unknown> | null;
  drive_file_id?: string | null;
  updated_at?: string;
}

// GET /api/voice/voices — curated ElevenLabs catalog entry.
export interface Voice {
  id: string;
  name: string;
  description?: string;
}

export interface KeyStatus {
  configured: boolean;
  keyTail?: string | null;
}

export interface SettingsData {
  default_model: string;
  theme: "light" | "dark" | "system";
  /** Keyed by service: openrouter, exa, elevenlabs, llamaparse. */
  keys: Record<string, KeyStatus>;
  storage: {
    dataDir: string;
    dbPath: string;
    vec: boolean;
    tables: number;
  };
}
