// Inline citation chip under an assistant reply. Shows the cite label
// (e.g. "report.pdf p.3"); clicking opens a dialog with the retrieved
// snippet + relevance score so the user can verify the grounding.

import { useState } from "react";
import { Quote } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { Citation } from "@/lib/types";

export function CitationPill({ citation, index }: { citation: Citation; index: number }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex max-w-[220px] items-center gap-1 rounded-full border border-accent/25 bg-accent/[0.07] px-2 py-0.5 text-[11px] font-medium text-accent transition hover:border-accent/50 hover:bg-accent/15"
        title={citation.cite_label}
      >
        <span className="shrink-0 tabular-nums">{index + 1}</span>
        <span className="truncate">{citation.cite_label}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Quote className="size-4 text-accent" />
              {citation.cite_label}
            </DialogTitle>
            <DialogDescription>
              Relevance {(citation.score * 100).toFixed(0)}%
            </DialogDescription>
          </DialogHeader>
          {citation.snippet ? (
            <blockquote className="max-h-72 overflow-y-auto scrollbar-thin rounded-lg border border-line bg-surface p-3 text-sm leading-relaxed text-ink/90 whitespace-pre-wrap">
              {citation.snippet}
            </blockquote>
          ) : (
            <p className="text-sm text-muted">
              No snippet available for this source.
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
