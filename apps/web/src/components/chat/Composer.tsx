// The chat input bar: auto-growing textarea (Enter sends, Shift+Enter
// newline), mic dictation (MediaRecorder → POST /api/voice/transcribe),
// attach-to-Drive chips (POST /api/drive/files multipart), a stop button
// while a turn is streaming, and a small model indicator slot.

import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUp,
  Loader2,
  Mic,
  Paperclip,
  Square,
  X,
} from "lucide-react";
import { authFetch, invalidateApi, useApi } from "@/lib/use-api";
import type { ChatAttachment, DriveFile, SettingsData } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const MAX_TEXTAREA_PX = 240;

type RecordingState = "idle" | "recording" | "transcribing";

export interface ComposerProps {
  onSend: (content: string, attachments: ChatAttachment[]) => void | Promise<void>;
  onStop?: () => void;
  isStreaming?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Seeds the textarea on mount — pair with a `key` to re-seed. */
  initialValue?: string;
  /** Small slot rendered in the footer row (e.g. the thread's model chip). */
  modelIndicator?: ReactNode;
}

export function Composer({
  onSend,
  onStop,
  isStreaming = false,
  disabled = false,
  placeholder = "Message Omni…",
  autoFocus = false,
  initialValue = "",
  modelIndicator,
}: ComposerProps) {
  const [input, setInput] = useState(initialValue);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // Voice dictation needs ELEVENLABS_API_KEY server-side; settings.keys is a
  // map of {configured} per service. Unknown → allow the attempt.
  const { data: settings } = useApi<SettingsData>("/api/settings");
  const voiceConfigured = settings?.keys?.elevenlabs?.configured ?? true;

  // Auto-grow with content, capped — long drafts scroll internally.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, MAX_TEXTAREA_PX)}px`;
  }, [input]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  const canSend =
    !disabled && !isStreaming && !uploading && (input.trim().length > 0 || attachments.length > 0);

  async function handleSend() {
    if (!canSend) return;
    const content = input.trim();
    const files = attachments;
    setInput("");
    setAttachments([]);
    setLocalError(null);
    await onSend(content, files);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSend();
    }
  }

  // ── Attachments: upload straight into Drive, then reference by file_id ──
  async function uploadFiles(list: FileList | File[]) {
    const files = [...list];
    if (files.length === 0) return;
    setUploading(true);
    setLocalError(null);
    try {
      for (const file of files) {
        const fd = new FormData();
        fd.append("file", file, file.name);
        const f = await authFetch<DriveFile>("/api/drive/files", {
          method: "POST",
          body: fd,
        });
        setAttachments((prev) => [
          ...prev,
          { file_id: f.id, name: f.name, mime: f.mime },
        ]);
      }
      void invalidateApi("/api/drive/files");
    } catch (err) {
      setLocalError(
        err instanceof Error
          ? `Upload failed: ${err.message}`
          : (err as { message?: string })?.message ?? "Upload failed.",
      );
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // ── Dictation: MediaRecorder default mime (webm/opus on Chrome/Firefox,
  // mp4 on Safari) — Scribe accepts all of them. ─────────────────────────
  async function startRecording() {
    if (recordingState !== "idle" || disabled) return;
    setLocalError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        // Always release the mic immediately, regardless of transcription
        // outcome — otherwise the browser shows the recording dot forever.
        for (const track of stream.getTracks()) track.stop();
        if (chunksRef.current.length === 0) {
          setRecordingState("idle");
          return;
        }
        const blob = new Blob(chunksRef.current, {
          type: chunksRef.current[0]?.type || "audio/webm",
        });
        setRecordingState("transcribing");
        try {
          const fd = new FormData();
          // Filename extension matters for multipart mime sniffing.
          const ext = (blob.type.split("/")[1] ?? "webm").split(";")[0];
          fd.append("audio", blob, `dictation.${ext}`);
          const data = await authFetch<{ text: string }>("/api/voice/transcribe", {
            method: "POST",
            body: fd,
          });
          const text = (data.text ?? "").trim();
          if (text) {
            // Append rather than replace so multiple dictation chunks compose.
            setInput((prev) => (prev ? `${prev} ${text}`.trim() : text));
            textareaRef.current?.focus();
          }
        } catch (err) {
          setLocalError(
            `Transcription failed: ${err instanceof Error ? err.message : (err as { message?: string })?.message ?? "unknown error"}`,
          );
        } finally {
          setRecordingState("idle");
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecordingState("recording");
    } catch (err) {
      setLocalError(
        `Could not start recording: ${err instanceof Error ? err.message : String(err)}`,
      );
      setRecordingState("idle");
    }
  }

  function stopRecording() {
    if (recordingState !== "recording") return;
    try {
      mediaRecorderRef.current?.stop();
    } catch {
      // already stopped
    }
  }

  // Stop the recorder if the composer unmounts mid-recording.
  useEffect(() => {
    return () => {
      try {
        mediaRecorderRef.current?.stop();
      } catch {
        // already stopped
      }
    };
  }, []);

  const micButton = (
    <button
      type="button"
      disabled={disabled || !voiceConfigured || recordingState === "transcribing"}
      onClick={recordingState === "recording" ? stopRecording : startRecording}
      aria-label={
        recordingState === "recording"
          ? "Stop and transcribe"
          : recordingState === "transcribing"
            ? "Transcribing"
            : "Dictate"
      }
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition",
        recordingState === "recording"
          ? "bg-rose-500/15 text-rose-500 hover:bg-rose-500/25"
          : "text-muted hover:bg-ink/5 hover:text-ink",
        (disabled || !voiceConfigured) && "opacity-40",
      )}
    >
      {recordingState === "transcribing" ? (
        <Loader2 className="size-4 animate-spin" />
      ) : recordingState === "recording" ? (
        <Square className="size-4 fill-current" />
      ) : (
        <Mic className="size-4" />
      )}
    </button>
  );

  return (
    <div className="border-t border-line bg-surface px-4 pb-4 pt-3 md:px-8">
      <div className="mx-auto max-w-3xl">
        {localError && (
          <p className="mb-2 text-xs text-rose-600 dark:text-rose-400">{localError}</p>
        )}

        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span
                key={a.file_id}
                className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface2 py-1 pl-2.5 pr-1.5 text-xs text-ink"
                title={a.mime}
              >
                <Paperclip className="size-3 text-muted" />
                <span className="max-w-[180px] truncate">{a.name}</span>
                <button
                  type="button"
                  onClick={() =>
                    setAttachments((prev) => prev.filter((x) => x.file_id !== a.file_id))
                  }
                  className="rounded-full p-0.5 text-muted transition hover:bg-ink/10 hover:text-ink"
                  aria-label={`Remove ${a.name}`}
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {uploading && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed border-line px-2.5 py-1 text-xs text-muted">
                <Loader2 className="size-3 animate-spin" />
                Uploading…
              </span>
            )}
          </div>
        )}

        <div
          className={cn(
            "flex items-end gap-1.5 rounded-2xl border border-line bg-surface2 p-2 shadow-sm transition",
            "focus-within:border-accent/50 focus-within:ring-2 focus-within:ring-accent/20",
          )}
        >
          {/* Attach → Drive */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void uploadFiles(e.target.files);
            }}
          />
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-ink/5 hover:text-ink disabled:opacity-40"
          >
            {uploading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Paperclip className="size-4" />
            )}
          </button>

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              recordingState === "recording" ? "Listening…" : placeholder
            }
            disabled={disabled}
            rows={1}
            className="max-h-[240px] min-h-[36px] w-full flex-1 resize-none bg-transparent px-1.5 py-1.5 text-[15px] leading-relaxed text-ink outline-none placeholder:text-muted disabled:opacity-60 scrollbar-thin"
          />

          {/* Mic — wrapped in a tooltip explaining the disabled state. */}
          {voiceConfigured ? (
            micButton
          ) : (
            <Tooltip>
              {/* span wrapper so the tooltip fires on a disabled button */}
              <TooltipTrigger asChild>
                <span className="inline-flex">{micButton}</span>
              </TooltipTrigger>
              <TooltipContent side="top">
                Add ELEVENLABS_API_KEY to enable dictation
              </TooltipContent>
            </Tooltip>
          )}

          {isStreaming ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop generating"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-ink text-surface transition hover:opacity-85"
            >
              <Square className="size-3.5 fill-current" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void handleSend()}
              disabled={!canSend}
              aria-label="Send"
              className={cn(
                "inline-flex size-8 shrink-0 items-center justify-center rounded-lg transition",
                canSend
                  ? "bg-accent text-white shadow-sm hover:bg-accent/90"
                  : "bg-ink/10 text-muted",
              )}
            >
              <ArrowUp className="size-4" />
            </button>
          )}
        </div>

        <div className="mt-1.5 flex items-center justify-between gap-2 px-1">
          <span className="text-[11px] text-muted">
            <kbd className="font-sans">Enter</kbd> to send ·{" "}
            <kbd className="font-sans">Shift+Enter</kbd> for a new line
          </span>
          {modelIndicator}
        </div>
      </div>
    </div>
  );
}
