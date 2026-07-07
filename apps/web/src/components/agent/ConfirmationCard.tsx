// Inline confirmation surface for a `confirmation_required` event. Two shapes,
// driven by card.reason:
//   'write'    → an external side-effect (drive_write to a shared place, a
//                DESTRUCTIVE_LABEL match, …): Confirm / Skip.
//   'question' → ask_user: a free-text answer, plus quick-pick buttons when
//                card.choices is present.
// Resolving POSTs through the parent's onResolve (which hits
// /confirm and lets the loop resume on the same open stream). The card
// disables itself while a resolve is in flight and after `resolved`.

import { useState } from "react";
import { motion } from "motion/react";
import { Loader2, MessageSquare, Send, ShieldAlert, X } from "lucide-react";
import type { ConfirmAction, ConfirmationCard as CardData } from "@/lib/agent-types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export interface ConfirmationCardProps {
  card: CardData;
  /** True once the card is resolved (locks the controls). */
  resolved?: boolean;
  onResolve: (action: ConfirmAction, answer?: string) => Promise<void>;
  className?: string;
}

export function ConfirmationCard({
  card,
  resolved,
  onResolve,
  className,
}: ConfirmationCardProps) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState<ConfirmAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isQuestion = card.reason === "question";
  const locked = !!resolved || busy !== null;

  async function resolve(action: ConfirmAction, ans?: string) {
    if (locked) return;
    setBusy(action);
    setError(null);
    try {
      await onResolve(action, ans);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not submit. Try again.");
      setBusy(null);
    }
  }

  const argEntries = Object.entries(card.args ?? {});

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className={cn(
        "overflow-hidden rounded-2xl border border-accent/40 bg-accent/[0.04]",
        resolved && "opacity-60",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-accent/20 px-4 py-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-ink text-surface">
          {isQuestion ? (
            <MessageSquare className="size-4" />
          ) : (
            <ShieldAlert className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="eyebrow">
            {isQuestion ? "The agent needs your input" : "Confirm this action"}
          </p>
          <p className="truncate font-mono text-[12px] text-muted" title={card.tool_name}>
            {card.tool_name}
          </p>
        </div>
      </div>

      <div className="px-4 py-3">
        <p className="text-[13px] leading-relaxed text-ink">{card.description}</p>

        {argEntries.length > 0 && (
          <dl className="mt-3 space-y-1.5 rounded-lg border border-line bg-surface2/60 p-3">
            {argEntries.map(([k, v]) => (
              <div key={k} className="flex gap-2 text-[12px]">
                <dt className="shrink-0 font-mono font-medium text-muted">{k}</dt>
                <dd className="min-w-0 flex-1 break-words font-mono text-ink/80">
                  {typeof v === "string" ? v : JSON.stringify(v)}
                </dd>
              </div>
            ))}
          </dl>
        )}

        {isQuestion && (
          <div className="mt-3">
            {card.choices && card.choices.length > 0 && (
              <div className="mb-2.5 flex flex-wrap gap-2">
                {card.choices.map((choice) => (
                  <button
                    key={choice}
                    type="button"
                    disabled={locked}
                    onClick={() => void resolve("confirm", choice)}
                    className={cn(
                      "rounded-full border border-line bg-surface2 px-3 py-1.5 text-[12px] font-medium text-ink transition",
                      "hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-50",
                    )}
                  >
                    {choice}
                  </button>
                ))}
              </div>
            )}
            <Textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  if (answer.trim()) void resolve("confirm", answer.trim());
                }
              }}
              disabled={locked}
              rows={2}
              placeholder="Type your answer…  (⌘/Ctrl+Enter to send)"
              className="bg-surface2"
              autoFocus
            />
          </div>
        )}

        {error && (
          <p className="mt-2 text-[12px] text-rose-600 dark:text-rose-400">{error}</p>
        )}

        {/* Actions */}
        <div className="mt-3 flex items-center gap-2">
          {isQuestion ? (
            <>
              <Button
                size="sm"
                onClick={() => void resolve("confirm", answer.trim())}
                disabled={locked || !answer.trim()}
              >
                {busy === "confirm" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Send />
                )}
                Send answer
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void resolve("skip")}
                disabled={locked}
              >
                {busy === "skip" ? <Loader2 className="animate-spin" /> : null}
                Skip
              </Button>
            </>
          ) : (
            <>
              <Button
                size="sm"
                onClick={() => void resolve("confirm")}
                disabled={locked}
              >
                {busy === "confirm" ? <Loader2 className="animate-spin" /> : null}
                Confirm
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => void resolve("skip")}
                disabled={locked}
              >
                {busy === "skip" ? <Loader2 className="animate-spin" /> : <X />}
                Skip
              </Button>
            </>
          )}
          {resolved && (
            <span className="ml-auto text-[11px] font-medium text-muted">Resolved</span>
          )}
        </div>
      </div>
    </motion.div>
  );
}
