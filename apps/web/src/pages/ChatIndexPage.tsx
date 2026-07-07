// Home / empty state for /chat (and /chat/new): a Genspark-style hero — a
// centered title, one big composer, and a row of colorful tool shortcuts.
// The thread doesn't exist yet — on first send we POST a new thread, then
// navigate to /chat/:id passing the message via router state; ChatThreadPage
// sends it on mount (exactly once), keeping all streaming logic in one place.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  FileText,
  Presentation,
  Table2,
  Image as ImageIcon,
  Podcast,
  Bot,
  Code2,
  GitBranch,
} from "lucide-react";
import { authFetch, invalidateApiPrefix } from "@/lib/use-api";
import type { ChatAttachment, ChatThread } from "@/lib/types";
import { Composer } from "@/components/chat/Composer";
import { Eyebrow } from "@/components/brand/Eyebrow";

const SUGGESTIONS = [
  "Summarize a file from my Drive",
  "Compare two models on one prompt",
  "Plan a weekend build",
  "Explain a concept simply",
];

// Tool shortcuts: a monochrome outline icon over a small label.
const TOOLS: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
}[] = [
  { href: "/tools/docs", label: "Docs", icon: FileText },
  { href: "/tools/slides", label: "Slides", icon: Presentation },
  { href: "/tools/sheets", label: "Sheets", icon: Table2 },
  { href: "/tools/images", label: "Image", icon: ImageIcon },
  { href: "/tools/apps", label: "App", icon: Code2 },
  { href: "/tools/podcast", label: "Podcast", icon: Podcast },
  { href: "/agent", label: "Agent", icon: Bot },
  { href: "/workflows", label: "Flows", icon: GitBranch },
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
    <div className="flex h-screen flex-col items-center justify-center overflow-y-auto scrollbar-thin px-6 py-10">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
        className="flex w-full max-w-2xl flex-col items-center"
      >
        {/* Title */}
        <Eyebrow className="mb-3 text-center">AI WORKSPACE</Eyebrow>
        <h1 className="text-center font-display text-3xl font-semibold tracking-tight text-ink sm:text-[2.5rem]">
          What can I help you <span className="grad-word">build</span>?
        </h1>
        <p className="mt-3 max-w-md text-center text-sm text-muted">
          Ask anything, or start with a tool — chat across models, ground answers
          in your Hubs, and turn ideas into docs, decks, and more.
        </p>

        {/* Big centered composer */}
        <div className="mt-7 w-full">
          <Composer
            key={prefill}
            variant="bare"
            initialValue={prefill}
            onSend={startChat}
            disabled={creating}
            autoFocus
            placeholder="Ask anything, create anything…"
          />
        </div>

        {/* Suggestion chips */}
        <div className="mt-3 flex flex-wrap justify-center gap-2">
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

        {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}

        {/* Tool shortcuts */}
        <div className="mt-10 flex flex-wrap items-start justify-center gap-x-2 gap-y-3">
          {TOOLS.map((t) => {
            const Icon = t.icon;
            return (
              <Link
                key={t.href}
                to={t.href}
                className="group flex w-[72px] flex-col items-center gap-1.5 rounded-lg px-1 py-2 text-center transition hover:bg-surface3/60"
              >
                <span className="grid size-11 place-items-center rounded-lg border border-line bg-surface2 text-muted transition group-hover:-translate-y-0.5 group-hover:border-accent/40 group-hover:text-ink">
                  <Icon className="size-5" />
                </span>
                <span className="text-[11px] font-medium text-muted group-hover:text-ink">
                  {t.label}
                </span>
              </Link>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
}
