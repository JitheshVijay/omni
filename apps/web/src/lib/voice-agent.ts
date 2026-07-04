// Client for the realtime voice agent. Asks the backend to provision an
// ElevenLabs convai session for a hub (or the global assistant), then opens
// the call with @elevenlabs/client. Fail-soft: when the backend reports
// voice_unconfigured we resolve to { configured: false } so the UI can show a
// setup nudge instead of throwing.
import { Conversation, type VoiceConversation } from "@elevenlabs/client";
import { authFetchRaw } from "@/lib/use-api";

export type VoiceConnStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

// "speaking" = the agent is talking; "listening" = it's the user's turn.
export type VoiceMode = "speaking" | "listening";

export interface VoiceTranscript {
  role: "user" | "agent";
  text: string;
}

export interface StartVoiceOptions {
  hubId?: string;
  onStatus?: (status: VoiceConnStatus) => void;
  onMode?: (mode: VoiceMode) => void;
  onTranscript?: (turn: VoiceTranscript) => void;
  onError?: (message: string) => void;
}

export type VoiceSession =
  | { configured: false }
  | {
      configured: true;
      conversation: VoiceConversation;
      end: () => Promise<void>;
    };

interface SessionPayload {
  agent_id: string;
  signed_url: string;
  conversation_token?: string;
}

/**
 * Start a voice call. Steps: (1) request a signed session from the backend,
 * (2) preflight mic permission for a clean error, (3) open the ElevenLabs
 * conversation. Prefers the WebRTC token (better barge-in) and falls back to
 * the signed-URL websocket path when the server couldn't mint one.
 *
 * Resolves to { configured: false } when voice isn't set up server-side.
 * Throws (for onError / caller catch) on mic denial or a provisioning error.
 */
export async function startVoiceSession(
  opts: StartVoiceOptions,
): Promise<VoiceSession> {
  // 1. Provision the session server-side.
  const res = await authFetchRaw("/api/voice/agent/session", {
    method: "POST",
    body: JSON.stringify(opts.hubId ? { hub_id: opts.hubId } : {}),
  });
  const json = (await res.json().catch(() => null)) as
    | { success?: boolean; data?: SessionPayload; error?: unknown; code?: string }
    | null;

  if (!res.ok) {
    if (json?.code === "voice_unconfigured") return { configured: false };
    const err = json?.error;
    throw new Error(
      typeof err === "string" ? err : `Couldn't start voice (${res.status}).`,
    );
  }
  const data = json?.data;
  if (!data?.signed_url && !data?.conversation_token) {
    throw new Error("Voice session response was empty.");
  }

  // 2. Preflight the mic so a denial surfaces as a clear message rather than a
  // cryptic failure deep inside the SDK's startSession.
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // Release the preflight stream immediately; the SDK opens its own.
    stream.getTracks().forEach((t) => t.stop());
  } catch {
    throw new Error(
      "Microphone access is blocked. Allow it in your browser, then try again.",
    );
  }

  // 3. Open the conversation.
  const connectOpts = data.conversation_token
    ? ({ conversationToken: data.conversation_token, connectionType: "webrtc" } as const)
    : ({ signedUrl: data.signed_url, connectionType: "websocket" } as const);

  opts.onStatus?.("connecting");
  const conversation = await Conversation.startSession({
    ...connectOpts,
    onConnect: () => opts.onStatus?.("connected"),
    onDisconnect: () => opts.onStatus?.("disconnected"),
    onError: (message) => {
      opts.onStatus?.("error");
      opts.onError?.(message || "Voice agent error.");
    },
    onModeChange: ({ mode }) => opts.onMode?.(mode),
    onMessage: ({ message, role }) => {
      if (!message) return;
      opts.onTranscript?.({ role, text: message });
    },
    // We wired only the end_call system tool server-side; no client tools.
    clientTools: {},
  });

  return {
    configured: true,
    // We never pass textOnly, so this is always a VoiceConversation; the SDK's
    // return type stays the union, hence the cast.
    conversation: conversation as VoiceConversation,
    end: async () => {
      try {
        await conversation.endSession();
      } catch {
        /* already torn down */
      }
    },
  };
}
