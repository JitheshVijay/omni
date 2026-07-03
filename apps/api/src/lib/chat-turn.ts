// One streaming chat turn: persist the user message, retrieve hub memory,
// stream the assistant reply from OpenRouter, persist the assistant row with
// usage/citations, bump the thread, and (on first turns) generate a title.
//
// Event order emitted through `emit` (the route sends the terminal done/error):
//   {type:"start",messageId} -> {type:"sources",citations}? ->
//   {type:"delta",text}* -> {type:"usage",usage}
import {
  LLM_REQUEST_OPTS,
  MODELS,
  all,
  calculateCost,
  callLLM,
  embedText,
  fromJson,
  nowISO,
  one,
  openai,
  providerRoutingForCache,
  run,
  uuid,
  wrapSystemForCache,
  type TokenUsage,
} from "@omni/sdk";
import { searchHubMemory, type HubMemoryHit } from "./hub-memory.js";

export interface ChatTurnArgs {
  threadId: string;
  userId: string;
  content: string;
  /** drive_files ids referenced by this user message. */
  attachments?: string[];
  /** Per-message model override; defaults to the thread's model. */
  model?: string;
  emit: (event: object) => void;
  signal: AbortSignal;
  /** Set false on regenerate — the user message already exists. Default true. */
  persistUserMessage?: boolean;
}

export interface ChatTurnResult {
  messageId: string;
  text: string;
  title?: string;
}

export interface Citation {
  chunk_id: string;
  file_id: string | null;
  cite_label: string;
  score: number;
  snippet: string;
}

interface ThreadRow {
  id: string;
  user_id: string;
  hub_id: string | null;
  title: string;
  model: string;
  usage_totals: string;
}

interface HubRow {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
}

const HISTORY_CAP = 30;
const MEMORY_TOP_K = 8;

const BASE_SYSTEM = [
  "You are Omni, a local-first AI workspace assistant. You help the user research, analyze, write, code, and work with their files and project hubs.",
  "Format answers in GitHub-flavored Markdown: fenced code blocks with language tags for code, tables when comparing options, tight prose with no filler preamble.",
  "Be direct about uncertainty. When hub excerpts are provided in the context, ground your answer in them and cite each borrowed fact inline with its bracketed label (e.g. [Page 3]). Never invent citations.",
].join("\n\n");

function buildSystemText(hub: HubRow | undefined): string {
  if (!hub) return BASE_SYSTEM;
  const parts = [BASE_SYSTEM, `## Hub context\nThis conversation lives in the "${hub.name}" hub.`];
  if (hub.description?.trim()) parts.push(`Hub description: ${hub.description.trim()}`);
  if (hub.instructions?.trim()) {
    parts.push(`## Hub instructions\n${hub.instructions.trim()}`);
  }
  return parts.join("\n\n");
}

function buildMemoryBlock(hits: HubMemoryHit[]): string {
  const parts: string[] = [
    "Excerpts retrieved from this hub's files, most relevant first. Cite anything you use with its bracketed label. If they don't cover the question, say so.",
  ];
  let budget = 12_000;
  for (const h of hits) {
    const source = h.file_name ? ` — ${h.file_name}` : "";
    const section = h.section_title ? ` (${h.section_title})` : "";
    const entry = `${h.cite_label}${source}${section}:\n${h.chunk_text.slice(0, 1500)}`;
    if (entry.length > budget) break;
    budget -= entry.length;
    parts.push(entry);
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Generate a 3-6 word thread title with the cheap model, update the row, and
 * return it — but never block the done event more than ~8s. If the model is
 * slow the promise keeps running fire-and-forget and updates the row late.
 */
function generateThreadTitle(
  threadId: string,
  userContent: string,
  assistantText: string,
): Promise<string | null> {
  const work = (async (): Promise<string | null> => {
    try {
      const raw = await callLLM({
        system:
          "You title chat conversations. Reply with ONLY the title: 3-6 words, plain text, no quotes, no trailing punctuation.",
        prompt: `Conversation opener:\n\nUser: ${userContent.slice(0, 1200)}\n\nAssistant: ${assistantText.slice(0, 1200)}\n\nTitle:`,
        model: MODELS.cheap,
        maxTokens: 24,
      });
      const title = raw
        .trim()
        .split("\n")[0]
        .replace(/^["'“‘]+|["'”’.]+$/g, "")
        .trim()
        .slice(0, 80);
      if (!title) return null;
      run(
        "UPDATE chat_threads SET title = ?, updated_at = ? WHERE id = ?",
        title,
        nowISO(),
        threadId,
      );
      return title;
    } catch {
      return null;
    }
  })();
  const timeout = new Promise<null>((resolve) => {
    const t = setTimeout(() => resolve(null), 8_000);
    t.unref?.();
  });
  return Promise.race([work, timeout]);
}

// Structural stream-chunk shape (OpenRouter's OpenAI-compatible SSE chunks).
interface StreamChunk {
  choices?: Array<{ delta?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    cache_creation_input_tokens?: number;
  } | null;
}

type OaiMessage = { role: "system" | "user" | "assistant"; content: unknown };

// The OpenAI SDK's create() overloads fight structural message arrays under
// strict TS; bind a loosely-typed alias once and keep the loosening local.
const createChatStream = openai.chat.completions.create.bind(
  openai.chat.completions,
) as unknown as (
  body: Record<string, unknown>,
  options?: Record<string, unknown>,
) => Promise<AsyncIterable<StreamChunk>>;

export async function runChatTurn(args: ChatTurnArgs): Promise<ChatTurnResult> {
  const { threadId, userId, content, emit, signal } = args;

  const thread = one<ThreadRow>(
    "SELECT * FROM chat_threads WHERE id = ? AND user_id = ?",
    threadId,
    userId,
  );
  if (!thread) throw new Error("Thread not found");
  const hub = thread.hub_id
    ? one<HubRow>(
        "SELECT id, name, description, instructions FROM hubs WHERE id = ? AND user_id = ?",
        thread.hub_id,
        userId,
      )
    : undefined;
  const model = args.model ?? thread.model ?? MODELS.default;

  // ── 1. Persist the user message ──
  if (args.persistUserMessage !== false) {
    let attachmentsJson: string | null = null;
    if (args.attachments && args.attachments.length > 0) {
      const placeholders = args.attachments.map(() => "?").join(",");
      const files = all<{ id: string; name: string; mime: string }>(
        `SELECT id, name, mime FROM drive_files WHERE user_id = ? AND id IN (${placeholders})`,
        userId,
        ...args.attachments,
      );
      attachmentsJson = JSON.stringify(
        files.map((f) => ({ file_id: f.id, name: f.name, mime: f.mime })),
      );
    }
    run(
      `INSERT INTO chat_messages (id, thread_id, user_id, role, content, attachments)
       VALUES (?, ?, ?, ?, ?, ?)`,
      uuid(),
      threadId,
      userId,
      "user",
      content,
      attachmentsJson,
    );
  }

  const messageId = uuid();
  emit({ type: "start", messageId });

  // ── 2. Hub memory retrieval ──
  let citations: Citation[] = [];
  let memoryBlock: string | null = null;
  if (hub) {
    const queryEmbedding = await embedText(content);
    if (queryEmbedding) {
      const hits = searchHubMemory(hub.id, queryEmbedding, MEMORY_TOP_K);
      if (hits.length > 0) {
        citations = hits.map((h) => ({
          chunk_id: h.chunk_id,
          file_id: h.file_id,
          cite_label: h.cite_label,
          score: Number(h.score.toFixed(4)),
          snippet: h.chunk_text.slice(0, 240),
        }));
        emit({ type: "sources", citations });
        memoryBlock = buildMemoryBlock(hits);
      }
    }
  }

  // ── 3. Assemble the prompt ──
  const messages: OaiMessage[] = [
    // Base persona + hub instructions: stable across turns, cacheable.
    { role: "system", content: wrapSystemForCache(buildSystemText(hub), model) },
  ];
  if (memoryBlock) messages.push({ role: "system", content: memoryBlock });
  // Today's date lives in its OWN system message so the changing value never
  // busts the prompt cache on the block above.
  messages.push({
    role: "system",
    content: `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
  });
  const history = all<{ role: string; content: string }>(
    `SELECT role, content FROM chat_messages
      WHERE thread_id = ? AND role IN ('user','assistant') AND content != ''
      ORDER BY created_at ASC, rowid ASC`,
    threadId,
  ).slice(-HISTORY_CAP);
  for (const m of history) {
    messages.push({ role: m.role as "user" | "assistant", content: m.content });
  }

  // ── 4. Stream the completion ──
  let text = "";
  let usage: TokenUsage | null = null;
  let aborted = signal.aborted;
  let streamError: Error | null = null;

  if (!aborted) {
    try {
      const stream = await createChatStream(
        {
          model,
          messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: 4096,
          ...providerRoutingForCache(model),
        },
        { ...LLM_REQUEST_OPTS, signal },
      );
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length > 0) {
          text += delta;
          emit({ type: "delta", text: delta });
        }
        const u = chunk.usage;
        if (u && typeof u.prompt_tokens === "number") {
          const inputTokens = u.prompt_tokens ?? 0;
          const outputTokens = u.completion_tokens ?? 0;
          const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
          const cacheWrite = u.cache_creation_input_tokens ?? 0;
          usage = {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: u.total_tokens ?? inputTokens + outputTokens,
            cost_usd: calculateCost(model, inputTokens, outputTokens, cacheRead, cacheWrite),
            model,
            ...(cacheRead > 0 ? { cache_read_tokens: cacheRead } : {}),
            ...(cacheWrite > 0 ? { cache_write_tokens: cacheWrite } : {}),
          };
        }
      }
    } catch (err) {
      if (signal.aborted) aborted = true;
      else streamError = err instanceof Error ? err : new Error(String(err));
    }
  }

  if (usage && !aborted && !streamError) {
    emit({ type: "usage", usage });
  }

  // A stream that died before producing anything: surface the error without
  // persisting an empty assistant row.
  if (streamError && text.length === 0) throw streamError;

  // ── 5. Persist the assistant message + bump the thread ──
  const errorNote = aborted
    ? "aborted"
    : streamError
      ? (streamError.message ?? "stream error").slice(0, 300)
      : null;
  run(
    `INSERT INTO chat_messages
       (id, thread_id, user_id, role, content, model, usage, citations, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    messageId,
    threadId,
    userId,
    "assistant",
    text,
    model,
    usage ? JSON.stringify(usage) : null,
    citations.length > 0 ? JSON.stringify(citations) : null,
    errorNote,
  );

  const totals =
    fromJson<{ input_tokens: number; output_tokens: number; cost_usd: number }>(
      thread.usage_totals,
    ) ?? { input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  if (usage) {
    totals.input_tokens = (totals.input_tokens ?? 0) + usage.input_tokens;
    totals.output_tokens = (totals.output_tokens ?? 0) + usage.output_tokens;
    totals.cost_usd = Number(((totals.cost_usd ?? 0) + usage.cost_usd).toFixed(6));
  }
  run(
    "UPDATE chat_threads SET usage_totals = ?, updated_at = ? WHERE id = ?",
    JSON.stringify(totals),
    nowISO(),
    threadId,
  );

  // Partial text was persisted with the error note; still surface the failure.
  if (streamError) throw streamError;

  // ── 6. First-turn title ──
  let title: string | undefined;
  if (!aborted) {
    const count =
      one<{ n: number }>(
        "SELECT COUNT(*) AS n FROM chat_messages WHERE thread_id = ?",
        threadId,
      )?.n ?? 0;
    if (count <= 2) {
      title = (await generateThreadTitle(threadId, content, text)) ?? undefined;
    }
  }

  return { messageId, text, ...(title ? { title } : {}) };
}
