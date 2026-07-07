// Read-aloud infrastructure. useReadAloud() turns any text source into
// queued ElevenLabs audio: the text is stripped of markdown, chunked at
// sentence boundaries (~2500 chars, under the /api/voice/tts 4000 limit),
// and each chunk is POSTed to /api/voice/tts sequentially. Chunk 1 starts
// playing while chunk 2 is still fetching, so long documents feel instant.
// The companion <MiniPlayer/> is a fixed bottom-right dock with play/pause,
// stop, "chunk i/n" progress, and a voice picker fed by /api/voice/voices.
//
// Blob URLs are revoked on stop/unmount; a session counter guards every
// await so a stale generation can never touch the live player.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AudioLines, Loader2, Pause, Play, Square, TriangleAlert } from "lucide-react";
import { useApi, authFetchRaw } from "@/lib/use-api";
import { parseApiError } from "@/lib/api-error";
import type { Voice } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CHUNK_TARGET_CHARS = 2500;

// ── Voice catalog ────────────────────────────────────────────────────────

export interface VoiceCatalog {
  configured: boolean;
  voices: Voice[];
}

/** GET /api/voice/voices: `configured` is null while the request is in
 *  flight so buttons can render optimistically instead of flashing off. */
export function useVoiceCatalog(): { configured: boolean | null; voices: Voice[] } {
  const { data } = useApi<VoiceCatalog>("/api/voice/voices");
  return { configured: data?.configured ?? null, voices: data?.voices ?? [] };
}

export const VOICE_UNCONFIGURED_HINT = "Add ELEVENLABS_API_KEY to enable voice";

// ── Text preparation ─────────────────────────────────────────────────────

// Markdown → speakable plain text: drop code fences/images/cite tokens,
// unwrap links to their labels, strip #/*/_/> markers and table pipes.
export function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ") // fenced code blocks
    .replace(/`([^`]*)`/g, "$1") // inline code
    .replace(/\[\[cite:\d+:[^\]]*?\]\]/g, "") // citation tokens
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1") // links -> label
    .replace(/^#{1,6}\s+/gm, "") // heading markers
    .replace(/^\s*>\s?/gm, "") // blockquote markers
    .replace(/^\s*[-*+]\s+/gm, "") // bullet markers
    .replace(/^\s*\d+\.\s+/gm, "") // ordered-list markers
    .replace(/(\*\*|__|\*|_|~~)/g, "") // emphasis markers
    .replace(/^\|.*\|$/gm, (row) => row.replace(/\|/g, " ")) // table pipes
    .replace(/^[-=_|:\s]{3,}$/gm, " ") // hr / table separators
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Split at sentence boundaries, packing sentences up to ~CHUNK_TARGET_CHARS.
// A pathological unbroken run is hard-split so no chunk exceeds the limit.
export function chunkTextForTts(text: string, target = CHUNK_TARGET_CHARS): string[] {
  const sentences = text.match(/[^.!?\n]+[.!?]+[\s]*|[^.!?\n]+\n*|\n+/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (sentence.length > target) {
      if (current.trim()) chunks.push(current.trim());
      current = "";
      for (let i = 0; i < sentence.length; i += target) {
        chunks.push(sentence.slice(i, i + target).trim());
      }
      continue;
    }
    if (current.length + sentence.length > target && current.trim()) {
      chunks.push(current.trim());
      current = "";
    }
    current += sentence;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

// ── useReadAloud ─────────────────────────────────────────────────────────

export type ReadAloudStatus = "idle" | "loading" | "playing" | "paused";

export interface ReadAloudControls {
  status: ReadAloudStatus;
  /** 1-based index of the chunk currently playing (0 when idle). */
  chunkIndex: number;
  chunkCount: number;
  error: string | null;
  /** null while the catalog request is in flight. */
  configured: boolean | null;
  voices: Voice[];
  voiceId: string | null;
  setVoiceId: (id: string) => void;
  /** Start reading. `textOverride` wins over the hook's textProvider. */
  play: (textOverride?: string) => Promise<void>;
  /** Toggle pause/resume of the current chunk. */
  toggle: () => void;
  stop: () => void;
}

type TextProvider = () => string | null | undefined | Promise<string | null | undefined>;

export function useReadAloud(textProvider?: TextProvider): ReadAloudControls {
  const { configured, voices } = useVoiceCatalog();

  const [status, setStatus] = useState<ReadAloudStatus>("idle");
  const [chunkIndex, setChunkIndex] = useState(0);
  const [chunkCount, setChunkCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [voiceId, setVoiceIdState] = useState<string | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const sessionRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const urlsRef = useRef<string[]>([]);
  // Resolves the in-flight playUrl() promise when stop() interrupts playback.
  const endedResolverRef = useRef<(() => void) | null>(null);
  const voiceIdRef = useRef<string | null>(null);
  const providerRef = useRef<TextProvider | undefined>(textProvider);
  providerRef.current = textProvider;

  const setVoiceId = useCallback((id: string) => {
    voiceIdRef.current = id;
    setVoiceIdState(id);
  }, []);

  const releaseUrls = useCallback(() => {
    for (const url of urlsRef.current) URL.revokeObjectURL(url);
    urlsRef.current = [];
  }, []);

  const stop = useCallback(() => {
    sessionRef.current += 1; // invalidates every awaited step
    abortRef.current?.abort();
    abortRef.current = null;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
    }
    endedResolverRef.current?.();
    endedResolverRef.current = null;
    releaseUrls();
    setStatus("idle");
    setChunkIndex(0);
    setChunkCount(0);
  }, [releaseUrls]);

  // Stop + release everything if the owning component unmounts mid-read.
  useEffect(() => stop, [stop]);

  const fetchChunk = useCallback(
    async (text: string, signal: AbortSignal): Promise<string> => {
      const res = await authFetchRaw("/api/voice/tts", {
        method: "POST",
        body: JSON.stringify({
          text,
          ...(voiceIdRef.current ? { voice_id: voiceIdRef.current } : {}),
        }),
        signal,
      });
      if (!res.ok) throw new Error((await parseApiError(res)).message);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      urlsRef.current.push(url);
      return url;
    },
    [],
  );

  const playUrl = useCallback((url: string): Promise<void> => {
    const audio = audioRef.current ?? new Audio();
    audioRef.current = audio;
    return new Promise<void>((resolve) => {
      const settle = () => {
        audio.removeEventListener("ended", settle);
        audio.removeEventListener("error", settle);
        endedResolverRef.current = null;
        resolve();
      };
      endedResolverRef.current = settle;
      audio.addEventListener("ended", settle);
      audio.addEventListener("error", settle);
      audio.src = url;
      audio.play().catch(() => settle()); // autoplay blocked → skip forward
    });
  }, []);

  const play = useCallback(
    async (textOverride?: string) => {
      stop(); // reset any current session (also bumps sessionRef)
      const session = sessionRef.current;
      setError(null);

      let raw: string | null | undefined = textOverride;
      if (raw == null) {
        try {
          raw = await providerRef.current?.();
        } catch {
          raw = null;
        }
      }
      const text = stripMarkdownForSpeech(raw ?? "");
      if (!text) {
        setError("Nothing to read aloud.");
        return;
      }
      const chunks = chunkTextForTts(text);
      if (session !== sessionRef.current) return;

      setChunkCount(chunks.length);
      setChunkIndex(0);
      setStatus("loading");
      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        // Prefetch one chunk ahead: chunk i plays while i+1 downloads.
        let nextFetch: Promise<string> | null = fetchChunk(chunks[0], ctrl.signal);
        for (let i = 0; i < chunks.length; i++) {
          const url = await nextFetch!;
          if (session !== sessionRef.current) return;
          nextFetch =
            i + 1 < chunks.length ? fetchChunk(chunks[i + 1], ctrl.signal) : null;
          // Swallow a failed prefetch here; the await in the next loop pass
          // rethrows it at the right moment.
          nextFetch?.catch(() => {});
          setChunkIndex(i + 1);
          setStatus("playing");
          await playUrl(url);
          if (session !== sessionRef.current) return;
        }
        if (session === sessionRef.current) stop();
      } catch (err) {
        if (session !== sessionRef.current) return; // aborted by a newer session
        setError(
          err instanceof Error ? err.message : "Voice playback failed.",
        );
        stop();
      }
    },
    [fetchChunk, playUrl, stop],
  );

  const toggle = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (status === "playing") {
      audio.pause();
      setStatus("paused");
    } else if (status === "paused") {
      void audio.play();
      setStatus("playing");
    }
  }, [status]);

  return useMemo(
    () => ({
      status,
      chunkIndex,
      chunkCount,
      error,
      configured,
      voices,
      voiceId,
      setVoiceId,
      play,
      toggle,
      stop,
    }),
    [status, chunkIndex, chunkCount, error, configured, voices, voiceId, setVoiceId, play, toggle, stop],
  );
}

// ── MiniPlayer ───────────────────────────────────────────────────────────

/** Fixed bottom-right playback dock. Renders nothing while idle. Mount one
 *  per useReadAloud() instance, near the page/list root. */
export function MiniPlayer({
  controls,
  label,
}: {
  controls: ReadAloudControls;
  /** What is being read (doc title, "Assistant reply", …). */
  label?: string;
}) {
  const { status, chunkIndex, chunkCount, error, voices, voiceId, setVoiceId, toggle, stop } =
    controls;

  if (status === "idle" && !error) return null;

  const progress = chunkCount > 0 ? chunkIndex / chunkCount : 0;

  return (
    <div className="fixed bottom-4 right-4 z-40 w-72 rounded-2xl border border-line bg-surface2/95 p-3 shadow-xl backdrop-blur anim-pop-in print:hidden">
      {error ? (
        <div className="flex items-start gap-2">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-rose-500" />
          <p className="min-w-0 flex-1 break-words text-xs text-rose-600 dark:text-rose-400">
            {error}
          </p>
          <button
            type="button"
            onClick={stop}
            aria-label="Dismiss"
            className="rounded-md p-1 text-muted transition hover:bg-ink/5 hover:text-ink"
          >
            <Square className="size-3.5" />
          </button>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-2.5">
            <div
              className={cn(
                "grid size-9 shrink-0 place-items-center rounded-xl bg-accent/10 text-accent",
                status === "playing" && "animate-pulse",
              )}
            >
              {status === "loading" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <AudioLines className="size-4" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-ink">
                {label || "Reading aloud"}
              </p>
              <p className="text-[11px] tabular-nums text-muted">
                {status === "loading"
                  ? "Preparing audio…"
                  : `Chunk ${chunkIndex}/${chunkCount}${status === "paused" ? " · paused" : ""}`}
              </p>
            </div>
            <button
              type="button"
              onClick={toggle}
              disabled={status === "loading"}
              aria-label={status === "playing" ? "Pause" : "Resume"}
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent text-white shadow-sm transition hover:bg-accent/90 disabled:opacity-50"
            >
              {status === "playing" ? (
                <Pause className="size-4 fill-current" />
              ) : (
                <Play className="size-4 fill-current" />
              )}
            </button>
            <button
              type="button"
              onClick={stop}
              aria-label="Stop reading"
              className="grid size-8 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-ink/5 hover:text-ink"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          </div>

          {/* Chunk progress */}
          <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-ink/10">
            <div
              className="h-full rounded-full bg-accent transition-all duration-500"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>

          {voices.length > 0 && (
            <div className="mt-2.5">
              <Select value={voiceId ?? voices[0]?.id} onValueChange={setVoiceId}>
                <SelectTrigger className="h-8 text-xs" aria-label="Voice">
                  <SelectValue placeholder="Voice" />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((v) => (
                    <SelectItem key={v.id} value={v.id} className="text-xs">
                      {v.name}
                      {v.description ? (
                        <span className="text-muted"> ({v.description})</span>
                      ) : null}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </>
      )}
    </div>
  );
}
