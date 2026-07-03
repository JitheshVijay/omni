// Empty state for /chat (and /chat/new): a hero composer. The thread doesn't
// exist yet — on first send we POST a new thread, then navigate to
// /chat/:id passing the message via router state; ChatThreadPage sends it on
// mount (exactly once). That keeps all streaming logic in one place.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { Sparkles } from "lucide-react";
import { authFetch, invalidateApiPrefix } from "@/lib/use-api";
import type { ChatAttachment, ChatThread } from "@/lib/types";
import { Composer } from "@/components/chat/Composer";

const SUGGESTIONS = [
  "Summarize the key ideas in a file from my Drive",
  "Compare two models on the same prompt",
  "Draft a project plan for a weekend build",
  "Explain a concept like I'm five",
];

export interface ChatNavState {
  initialMessage?: string;
  attachments?: ChatAttachment[];
}

export default function ChatIndexPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prefill, setPrefill] = useState("");

  async function startChat(content: string, attachments: ChatAttachment[]) {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const thread = await authFetch<ChatThread>("/api/chat/threads", {
        method: "POST",
        body: JSON.stringify({}),
      });
      void invalidateApiPrefix("/api/chat/threads");
      navigate(`/chat/${thread.id}`, {
        state: { initialMessage: content, attachments } satisfies ChatNavState,
      });
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Could not start a chat.",
      );
      setCreating(false);
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto scrollbar-thin px-6 py-10">
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="flex w-full max-w-2xl flex-col items-center gap-4 text-center"
        >
          <div className="grid size-14 place-items-center rounded-2xl bg-gradient-to-br from-accent to-accent2 shadow-lg shadow-accent/20">
            <Sparkles className="size-7 text-white" />
          </div>
          <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
            What can I help with?
          </h1>
          <p className="max-w-md text-sm text-muted">
            Multi-model chat over OpenRouter — attach files, ground answers in your
            Hubs, and switch models mid-conversation.
          </p>

          <div className="mt-2 flex flex-wrap justify-center gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setPrefill(s)}
                className="rounded-full border border-line bg-surface2 px-3 py-1.5 text-xs text-muted transition hover:border-accent/40 hover:text-ink"
              >
                {s}
              </button>
            ))}
          </div>

          {error && (
            <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
          )}
        </motion.div>
      </div>

      {/* Keyed by prefill: tapping a suggestion remounts the composer with the
          suggestion seeded into the textarea, ready to edit or send. */}
      <Composer
        key={prefill}
        initialValue={prefill}
        onSend={startChat}
        disabled={creating}
        autoFocus
        placeholder="Start a new chat…"
      />
    </div>
  );
}
