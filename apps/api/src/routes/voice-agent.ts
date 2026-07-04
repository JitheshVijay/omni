// Realtime voice agent — talk to an Omni hub. Provisions an ElevenLabs
// Conversational-AI agent grounded in a hub's instructions + a compact
// memory digest, then hands the browser a signed URL (and, when available,
// a WebRTC conversation token) so @elevenlabs/client can open the call.
//
//   POST /api/voice/agent/session  { hub_id? }
//
// Fail-soft: no ELEVENLABS_API_KEY -> 400 voice_unconfigured; any ElevenLabs
// failure -> 502 voice_agent_error. Registered separately from voiceRoutes
// (transcribe/tts/voices) so the two concerns stay decoupled.
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "@omni/env-config";
import { all, one } from "@omni/sdk";
import type { AuthenticatedRequest } from "../middleware/auth.js";
import { DEFAULT_VOICE_ID, resolveVoiceId } from "../lib/voice-catalog.js";

// True at boot when the key is present. Every path below still re-checks
// env.ELEVENLABS_API_KEY before hitting ElevenLabs, so this is only the
// fast fail-soft gate.
export const voiceEnabled = (): boolean => Boolean(env.ELEVENLABS_API_KEY);

// How much hub memory to fold into the agent's system prompt. The digest is
// capped in characters (buildHubDigest); this caps the row scan that feeds it.
const DIGEST_CHUNK_LIMIT = 14;
const DIGEST_CHAR_CAP = 2000;
const INSTRUCTIONS_CHAR_CAP = 4000;

// ─── Pure prompt/digest builders (unit-tested) ────────────────────────────

export interface HubDigestChunk {
  cite_label?: string | null;
  section_title?: string | null;
  chunk_text: string;
}

export interface HubDigestInput {
  fileNames?: string[];
  chunks?: HubDigestChunk[];
}

/**
 * Fold a hub's file titles + opening memory chunks into a compact grounding
 * digest for the voice agent's system prompt. Pure + deterministic: takes
 * already-fetched rows, normalizes whitespace, and greedily packs lines up to
 * `cap` characters (never mid-word) so the prompt stays bounded regardless of
 * hub size. Returns "" when there's nothing to ground on.
 */
export function buildHubDigest(input: HubDigestInput, cap = DIGEST_CHAR_CAP): string {
  const lines: string[] = [];
  const files = (input.fileNames ?? []).map((f) => f.trim()).filter(Boolean);
  if (files.length > 0) {
    lines.push(`Attached documents: ${files.slice(0, 20).join(", ")}.`);
  }

  let used = lines.reduce((n, l) => n + l.length + 1, 0);
  for (const c of input.chunks ?? []) {
    const text = (c.chunk_text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const label = c.cite_label ? `[${c.cite_label.trim()}]` : "";
    const section = c.section_title ? ` (${c.section_title.trim()})` : "";
    const line = `${label}${section} ${text}`.trim();
    if (used + line.length + 1 > cap) {
      // Squeeze a truncated tail of this line in if there's meaningful room.
      const remaining = cap - used - 1;
      if (remaining > 80) {
        lines.push(line.slice(0, remaining).replace(/\s+\S*$/, "") + " …");
      }
      break;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}

/**
 * Assemble the voice agent's system prompt: base Omni voice persona, then the
 * hub's own instructions and memory digest when grounded to a hub. Pure so it
 * can be unit-tested and hashed for the agent cache key.
 */
export function buildVoiceSystemPrompt(opts: {
  hubName?: string | null;
  instructions?: string | null;
  digest?: string;
  today?: string;
}): string {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const lines: string[] = [
    "You are Omni, the user's voice assistant inside the Omni workspace.",
    opts.hubName
      ? `You are grounded in the user's hub "${opts.hubName}". Its instructions and a digest of its documents are below — answer as an expert on this hub's material.`
      : "You are a general voice assistant for the Omni workspace. Be helpful, warm, and to the point.",
    "",
    "Voice rules:",
    "- Speak naturally and conversationally. Keep turns short — 1 to 3 sentences.",
    "- Answer the question directly. Don't lecture or read long lists unless asked.",
    "- When you lean on one of the hub's documents, name it so the user can follow up.",
    "- If the hub's material doesn't cover something, say so plainly instead of guessing.",
    `- Today's date is ${today}.`,
  ];

  const instructions = (opts.instructions ?? "").trim();
  if (instructions) {
    lines.push("", "═══ HUB INSTRUCTIONS ═══", instructions.slice(0, INSTRUCTIONS_CHAR_CAP));
  }
  const digest = (opts.digest ?? "").trim();
  if (digest) {
    lines.push("", "═══ HUB MEMORY (excerpts from attached documents) ═══", digest);
  }
  return lines.join("\n");
}

function buildGreeting(hubName?: string | null): string {
  return hubName
    ? `Hey! I'm Omni, tuned in to your "${hubName}" hub. What would you like to dig into?`
    : "Hey! I'm Omni. What can I help you with?";
}

// ─── Hub grounding (DB) ───────────────────────────────────────────────────

interface HubRow {
  id: string;
  name: string;
  instructions: string | null;
}

/**
 * Pull a hub's grounding for the digest: attached file titles + the opening
 * chunks across its documents. We order by chunk_idx ASC so the digest is the
 * *start* of each document (intro/overview) rather than a recency dump — a
 * better "what is this hub about" snapshot. No embedding call (the digest is a
 * fixed grounding, not a query answer). Best-effort: never throws.
 */
function loadHubGrounding(hubId: string): HubDigestInput {
  let fileNames: string[];
  let chunks: HubDigestChunk[];
  try {
    fileNames = all<{ name: string }>(
      `SELECT f.name
         FROM hub_files hf
         JOIN drive_files f ON f.id = hf.file_id
        WHERE hf.hub_id = ?
        ORDER BY hf.created_at DESC
        LIMIT 20`,
      hubId,
    ).map((r) => r.name);
  } catch {
    fileNames = [];
  }
  try {
    chunks = all<HubDigestChunk>(
      `SELECT cite_label, section_title, chunk_text
         FROM hub_memory_chunks
        WHERE hub_id = ?
        ORDER BY chunk_idx ASC, created_at ASC
        LIMIT ?`,
      hubId,
      DIGEST_CHUNK_LIMIT,
    );
  } catch {
    chunks = [];
  }
  return { fileNames, chunks };
}

// ─── ElevenLabs agent provisioning ────────────────────────────────────────

const ELEVENLABS_BASE = "https://api.elevenlabs.io";
const CREATE_TIMEOUT_MS = 30_000;

// Cache created agent ids so we don't re-create an identical agent on every
// call. Keyed by a hash of the full agent body, so any change to the prompt,
// greeting, or voice (e.g. the user edits hub instructions or attaches a file)
// naturally mints a fresh agent while unchanged hubs reuse theirs.
const agentCache = new Map<string, string>();

interface AgentBody {
  name: string;
  conversation_config: Record<string, unknown>;
  platform_settings: Record<string, unknown>;
}

function buildAgentBody(opts: {
  agentName: string;
  systemPrompt: string;
  greeting: string;
  voiceId: string;
}): AgentBody {
  return {
    name: opts.agentName.slice(0, 80),
    conversation_config: {
      agent: {
        first_message: opts.greeting,
        language: "en",
        prompt: {
          prompt: opts.systemPrompt,
          // ElevenLabs-hosted LLM. gpt-4o-mini is a supported convai model and
          // fast enough for low-latency turns; Omni's OpenRouter routing is
          // for its own text paths, not this in-agent LLM.
          llm: "gpt-4o-mini",
          temperature: 0.7,
          tools: [
            {
              type: "system",
              name: "end_call",
              description:
                "End the conversation when the user says they're done or it reaches a natural conclusion.",
            },
          ],
        },
      },
      tts: {
        model_id: "eleven_flash_v2_5",
        voice_id: opts.voiceId,
        stability: 0.5,
        speed: 1.0,
        similarity_boost: 0.75,
        agent_output_audio_format: "pcm_24000",
      },
      turn: {
        turn_timeout: 7,
        silence_end_call_timeout: 30,
      },
      conversation: {
        max_duration_seconds: 1200,
        client_events: [
          "audio",
          "interruption",
          "agent_response",
          "user_transcript",
          "agent_response_correction",
        ],
      },
    },
    // enable_auth=true makes the agent require a signed conversation token /
    // signed URL, which is what get-signed-url and conversation/token produce.
    // Without it the WebRTC handshake 401s.
    platform_settings: {
      auth: { enable_auth: true },
    },
  };
}

/** Create (or reuse a cached) ElevenLabs convai agent. Throws on failure. */
async function ensureAgent(
  apiKey: string,
  cacheKeyPrefix: string,
  body: AgentBody,
  log: FastifyBaseLogger,
): Promise<string> {
  const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  const cacheKey = `${cacheKeyPrefix}:${hash}`;
  const cached = agentCache.get(cacheKey);
  if (cached) return cached;

  const res = await fetch(`${ELEVENLABS_BASE}/v1/convai/agents/create`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  });
  if (!res.ok) {
    const t = (await res.text().catch(() => "")).slice(0, 200);
    log.error({ status: res.status, body: t }, "[voice-agent] agent create failed");
    throw new Error(`agent create failed (${res.status})`);
  }
  const data = (await res.json()) as { agent_id?: string };
  if (!data.agent_id) throw new Error("agent create returned no agent_id");
  agentCache.set(cacheKey, data.agent_id);
  return data.agent_id;
}

/** Fetch a signed WebSocket URL for an agent. Throws on failure. */
async function getSignedUrl(apiKey: string, agentId: string): Promise<string> {
  const res = await fetch(
    `${ELEVENLABS_BASE}/v1/convai/conversation/get-signed-url?agent_id=${agentId}`,
    { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`signed URL fetch failed (${res.status})`);
  const data = (await res.json()) as { signed_url?: string };
  if (!data.signed_url) throw new Error("signed URL fetch returned no url");
  return data.signed_url;
}

/**
 * Best-effort WebRTC conversation-token mint. WebRTC is ElevenLabs' preferred
 * browser transport (more reliable barge-in). Returns undefined on any
 * failure — the client falls back to the signed-URL websocket path.
 */
async function mintConversationToken(
  apiKey: string,
  agentId: string,
  log: FastifyBaseLogger,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `${ELEVENLABS_BASE}/v1/convai/conversation/token?agent_id=${agentId}`,
      { headers: { "xi-api-key": apiKey }, signal: AbortSignal.timeout(CREATE_TIMEOUT_MS) },
    );
    if (!res.ok) {
      log.warn({ status: res.status }, "[voice-agent] token mint failed; using websocket");
      return undefined;
    }
    const data = (await res.json()) as { token?: string };
    return data.token;
  } catch (err) {
    log.warn(
      { err: (err as Error).message?.slice(0, 120) },
      "[voice-agent] token mint threw; using websocket",
    );
    return undefined;
  }
}

// ─── Route ────────────────────────────────────────────────────────────────

const SessionSchema = z.object({
  hub_id: z.string().min(1).optional(),
});

export async function voiceAgentRoutes(app: FastifyInstance) {
  // ── POST /api/voice/agent/session ──
  app.post("/api/voice/agent/session", async (request, reply) => {
    const apiKey = env.ELEVENLABS_API_KEY;
    if (!apiKey) {
      return reply.status(400).send({
        success: false,
        error: "voice not configured",
        code: "voice_unconfigured",
      });
    }

    const parsed = SessionSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ success: false, error: parsed.error.issues });
    }
    const { userId } = request as AuthenticatedRequest;

    // Resolve hub grounding (optional). Unknown/foreign hub ids 404 rather
    // than silently falling back to an ungrounded agent — the caller asked
    // for a specific hub.
    let hub: HubRow | undefined;
    let grounding: HubDigestInput = {};
    if (parsed.data.hub_id) {
      hub = one<HubRow>(
        "SELECT id, name, instructions FROM hubs WHERE id = ? AND user_id = ?",
        parsed.data.hub_id,
        userId,
      );
      if (!hub) {
        return reply
          .status(404)
          .send({ success: false, error: "Hub not found", code: "not_found" });
      }
      grounding = loadHubGrounding(hub.id);
    }

    const digest = buildHubDigest(grounding);
    const systemPrompt = buildVoiceSystemPrompt({
      hubName: hub?.name,
      instructions: hub?.instructions,
      digest,
    });
    const greeting = buildGreeting(hub?.name);
    const voiceId = resolveVoiceId(DEFAULT_VOICE_ID);
    const agentBody = buildAgentBody({
      agentName: hub ? `Omni · ${hub.name}` : "Omni Assistant",
      systemPrompt,
      greeting,
      voiceId,
    });

    try {
      const agentId = await ensureAgent(
        apiKey,
        hub?.id ?? "__none__",
        agentBody,
        request.log,
      );
      const signedUrl = await getSignedUrl(apiKey, agentId);
      const conversationToken = await mintConversationToken(apiKey, agentId, request.log);
      return {
        success: true,
        data: {
          agent_id: agentId,
          signed_url: signedUrl,
          ...(conversationToken ? { conversation_token: conversationToken } : {}),
        },
      };
    } catch (err) {
      const message = (err as Error).message?.slice(0, 200) ?? "voice agent error";
      request.log.error({ err: message }, "[voice-agent] provisioning failed");
      return reply
        .status(502)
        .send({ success: false, error: message, code: "voice_agent_error" });
    }
  });
}
