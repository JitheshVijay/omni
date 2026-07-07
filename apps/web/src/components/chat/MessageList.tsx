// The scrolling conversation. Renders persisted messages plus the in-flight
// optimistic pair (pending user bubble + streaming assistant draft).
// Auto-scroll stays pinned to the bottom while new content arrives, but
// "escapes" as soon as the user scrolls up; a floating "jump to latest"
// button brings them back. Assistant turns get a footer row: copy, model
// chip, cost chip, and citation pills.

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  ArrowDown,
  Check,
  Copy,
  Cpu,
  MessageSquare,
  Paperclip,
  TriangleAlert,
  Volume2,
} from "lucide-react";
import { MarkdownMessage } from "@/components/MarkdownMessage";
import { CitationPill } from "@/components/chat/CitationPill";
import {
  useReadAloud,
  MiniPlayer,
  VOICE_UNCONFIGURED_HINT,
  type ReadAloudControls,
} from "@/lib/audio-player";
import type { ChatMessage, Citation, TokenUsage } from "@/lib/types";
import type { PendingUserMessage } from "@/lib/chat/use-chat-stream";
import { cn, formatCost, parseMaybeJson, prettyModel } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const PIN_THRESHOLD_PX = 120;

export interface MessageListProps {
  messages: ChatMessage[];
  isStreaming: boolean;
  streamingText: string;
  streamingCitations: Citation[];
  pendingUserMessage: PendingUserMessage | null;
  streamError: string | null;
}

export function MessageList({
  messages,
  isStreaming,
  streamingText,
  streamingCitations,
  pendingUserMessage,
  streamError,
}: MessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Pinned = the user is at (or near) the bottom, so new content should keep
  // the view glued there. Scrolling up unpins until they come back down.
  const pinnedRef = useRef(true);
  const [showScrollBtn, setShowScrollBtn] = useState(false);

  // One read-aloud queue for the whole list; each assistant turn's Listen
  // button feeds its own text into it; the MiniPlayer docks bottom-right.
  const readAloud = useReadAloud();

  const visible = useMemo(
    () => messages.filter((m) => m.role === "user" || m.role === "assistant"),
    [messages],
  );

  useEffect(() => {
    if (!pinnedRef.current) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, streamingText, pendingUserMessage, streamError]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    pinnedRef.current = dist < PIN_THRESHOLD_PX;
    setShowScrollBtn(dist > PIN_THRESHOLD_PX);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowScrollBtn(false);
  }

  const empty =
    visible.length === 0 && !pendingUserMessage && !streamingText && !isStreaming;

  return (
    <div className="relative flex-1 min-h-0">
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="h-full overflow-y-auto scrollbar-thin px-4 py-6 md:px-8"
      >
        <div className="mx-auto flex max-w-3xl flex-col gap-5">
          {empty ? (
            <div className="mt-24 flex flex-col items-center gap-3 text-center">
              <div className="grid size-12 place-items-center rounded-lg bg-ink text-surface">
                <MessageSquare className="size-6" />
              </div>
              <p className="font-display text-lg font-semibold text-ink">
                Start the conversation
              </p>
              <p className="max-w-xs text-sm text-muted">
                Ask anything: switch models mid-thread, attach files from Drive, or
                dictate with the mic.
              </p>
            </div>
          ) : (
            <>
              {visible.map((m) =>
                m.role === "user" ? (
                  <UserBubble key={m.id} message={m} />
                ) : (
                  <AssistantTurn key={m.id} message={m} readAloud={readAloud} />
                ),
              )}

              {pendingUserMessage && (
                <UserBubble
                  optimistic
                  message={{
                    content: pendingUserMessage.content,
                    attachments: pendingUserMessage.attachments,
                  }}
                />
              )}

              {(streamingText || isStreaming) && (
                <StreamingDraft
                  text={streamingText}
                  citations={streamingCitations}
                  waiting={!streamingText}
                />
              )}

              {streamError && (
                <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] px-3.5 py-2.5 text-sm text-rose-600 dark:text-rose-400">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                  <span className="min-w-0 break-words">{streamError}</span>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {showScrollBtn && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Scroll to latest"
          className="absolute bottom-4 left-1/2 z-10 -translate-x-1/2 inline-flex items-center gap-1.5 rounded-full border border-line bg-surface2/95 px-3 py-1.5 text-xs font-medium text-ink backdrop-blur transition hover:bg-surface2"
        >
          <ArrowDown className="size-3.5" />
          Latest
        </button>
      )}

      <MiniPlayer controls={readAloud} label="Assistant reply" />
    </div>
  );
}

function UserBubble({
  message,
  optimistic,
}: {
  message: Pick<ChatMessage, "content"> & {
    attachments?: ChatMessage["attachments"];
  };
  optimistic?: boolean;
}) {
  const attachments = parseMaybeJson<{ file_id: string; name: string; mime: string }[]>(
    message.attachments ?? null,
  );
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={cn("flex justify-end", optimistic && "opacity-90")}
    >
      <div className="max-w-[85%] min-w-0 break-words rounded-lg bg-ink px-4 py-2.5 text-[15px] leading-relaxed text-surface whitespace-pre-wrap">
        {message.content}
        {attachments && attachments.length > 0 && (
          <div className={cn("flex flex-wrap gap-1.5", message.content && "mt-2")}>
            {attachments.map((a, i) => (
              <span
                key={`${a.file_id}-${i}`}
                className="inline-flex items-center gap-1 rounded-md bg-surface/15 px-2 py-0.5 text-[11px]"
                title={a.mime}
              >
                <Paperclip className="size-3" />
                <span className="max-w-[160px] truncate">{a.name}</span>
              </span>
            ))}
          </div>
        )}
      </div>
    </motion.div>
  );
}

function AssistantTurn({
  message,
  readAloud,
}: {
  message: ChatMessage;
  readAloud: ReadAloudControls;
}) {
  const usage = parseMaybeJson<TokenUsage>(message.usage);
  const citations = parseMaybeJson<Citation[]>(message.citations) ?? [];
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="group flex max-w-full flex-col items-start gap-1.5"
    >
      {message.content ? (
        <MarkdownMessage content={message.content} />
      ) : message.error ? null : (
        <p className="text-sm italic text-muted">(empty reply)</p>
      )}

      {message.error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.06] px-3.5 py-2.5 text-sm text-rose-600 dark:text-rose-400">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0 break-words">{message.error}</span>
        </div>
      )}

      {citations.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {citations.map((c, i) => (
            <CitationPill key={c.chunk_id ?? i} citation={c} index={i} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <TurnCopyButton text={message.content} />
        {message.content && <TurnListenButton text={message.content} readAloud={readAloud} />}
        {(message.model || usage) && (
          <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface2 px-2 py-0.5 text-[11px] text-muted">
            <Cpu className="size-3" />
            {prettyModel(usage?.model ?? message.model)}
          </span>
        )}
        {usage && usage.cost_usd > 0 && (
          <span
            className="inline-flex items-center rounded-full border border-line bg-surface2 px-2 py-0.5 text-[11px] tabular-nums text-muted"
            title={`${usage.input_tokens.toLocaleString()} in / ${usage.output_tokens.toLocaleString()} out tokens`}
          >
            {formatCost(usage.cost_usd)}
          </span>
        )}
      </div>
    </motion.div>
  );
}

// The assistant reply currently streaming in. Before the first delta lands,
// show a subtle thinking indicator instead of an empty prose block.
function StreamingDraft({
  text,
  citations,
  waiting,
}: {
  text: string;
  citations: Citation[];
  waiting: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex max-w-full flex-col items-start gap-1.5"
    >
      {waiting ? (
        <div className="flex items-center gap-1.5 px-1 py-2" aria-label="Thinking">
          {[0, 1, 2].map((i) => (
            <motion.span
              key={i}
              className="size-1.5 rounded-full bg-accent/70"
              animate={{ opacity: [0.25, 1, 0.25] }}
              transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
            />
          ))}
        </div>
      ) : (
        <div className="min-w-0">
          <MarkdownMessage content={text} />
          <span className="stream-caret" aria-hidden />
        </div>
      )}
      {citations.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {citations.map((c, i) => (
            <CitationPill key={c.chunk_id ?? i} citation={c} index={i} />
          ))}
        </div>
      )}
    </motion.div>
  );
}

// Reads this reply aloud through the list-level ReadAloud queue. Disabled
// (with an explanatory tooltip) until ELEVENLABS_API_KEY is configured.
function TurnListenButton({
  text,
  readAloud,
}: {
  text: string;
  readAloud: ReadAloudControls;
}) {
  const disabled = readAloud.configured === false;
  const button = (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void readAloud.play(text)}
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-ink/5 hover:text-ink",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted",
      )}
      title={disabled ? undefined : "Read this reply aloud"}
      aria-label="Read this reply aloud"
    >
      <Volume2 className="size-3" />
      Listen
    </button>
  );
  if (!disabled) return button;
  return (
    <Tooltip>
      {/* span wrapper so the tooltip fires on a disabled button */}
      <TooltipTrigger asChild>
        <span className="inline-flex">{button}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{VOICE_UNCONFIGURED_HINT}</TooltipContent>
    </Tooltip>
  );
}

function TurnCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* clipboard blocked; no-op */
        }
      }}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted transition hover:bg-ink/5 hover:text-ink"
      title={copied ? "Copied" : "Copy reply"}
      aria-label={copied ? "Copied" : "Copy reply"}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}
