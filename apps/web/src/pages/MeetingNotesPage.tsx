// /tools/notes — AI Meeting Notes home. Paste a transcript (Zoom / Meet /
// Teams / hand-typed) + an optional title, then "Generate notes" streams
// streamGenerate("meeting") INLINE: status + the notes markdown streaming
// into a live preview (MarkdownMessage). On the terminal artifact event it
// navigates to the doc editor (/tools/docs/:id). Below is a "Recent notes"
// grid of kind=doc artifacts filtered client-side to meta.subtype ===
// "meeting".

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { ArrowLeft, Loader2, NotebookPen, Sparkles } from "lucide-react";
import { useApi, invalidateApiPrefix } from "@/lib/use-api";
import { streamGenerate } from "@/lib/generate";
import type { ArtifactSummary } from "@/lib/types";
import { timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { MarkdownMessage } from "@/components/MarkdownMessage";

const LIST_PATH = "/api/artifacts?kind=doc&limit=50";

export default function MeetingNotesPage() {
  const navigate = useNavigate();
  const { data, isInitialLoading } = useApi<{ artifacts: ArtifactSummary[] }>(LIST_PATH);
  const notes = (data?.artifacts ?? []).filter(
    (a) => a.meta?.subtype === "meeting",
  );

  const [transcript, setTranscript] = useState("");
  const [title, setTitle] = useState("");

  const [generating, setGenerating] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [genError, setGenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function generate() {
    const trimmed = transcript.trim();
    if (trimmed.length < 20 || generating) return;
    setGenerating(true);
    setGenError(null);
    setDraft("");
    setStatusLabel("Starting…");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamGenerate({
        name: "meeting",
        body: {
          transcript: trimmed,
          ...(title.trim() ? { title: title.trim() } : {}),
        },
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") {
            setStatusLabel(e.label);
          } else if (e.type === "delta" && e.channel === "markdown") {
            if (typeof e.data === "string") setDraft((d) => d + e.data);
          } else if (e.type === "artifact") {
            void invalidateApiPrefix("/api/artifacts");
            navigate(`/tools/docs/${e.artifact.id}`);
          } else if (e.type === "error") {
            setGenError(e.message);
            setGenerating(false);
          }
        },
      });
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setGenError(err instanceof Error ? err.message : "Generation failed.");
      }
    } finally {
      if (!ctrl.signal.aborted) {
        setGenerating(false);
        setStatusLabel(null);
      }
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-5xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <div className="mb-4 pl-10 lg:pl-0">
        <Button variant="ghost" size="iconSm" asChild aria-label="Back to Tools">
          <Link to="/tools">
            <ArrowLeft />
          </Link>
        </Button>
      </div>

      <div className="mb-6 text-center">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          Turn a transcript into <span className="grad-word">notes</span>
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
          Paste a Zoom / Meet / Teams transcript, or any notes — Omni writes a
          clean summary with key points, decisions, action items, and open
          questions.
        </p>
      </div>

      {/* New notes panel */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="rounded-2xl border border-line bg-gradient-to-b from-accent/[0.05] to-transparent p-5"
      >
        <div className="mb-3 flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent2 text-white shadow-sm">
            <NotebookPen className="size-4" />
          </div>
          <h2 className="font-display text-base font-semibold text-ink">New notes</h2>
        </div>

        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title (optional) — e.g. “Q3 Planning Sync”"
          maxLength={200}
          disabled={generating}
          className="mb-3 bg-surface2"
        />

        <Textarea
          value={transcript}
          onChange={(e) => setTranscript(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void generate();
            }
          }}
          placeholder="Paste your meeting transcript here…"
          rows={10}
          maxLength={60_000}
          disabled={generating}
          className="bg-surface2 font-mono text-[13px]"
        />

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <p className="text-xs text-muted">
            Paste a Zoom/Meet/Teams transcript, or any notes.{" "}
            <span className="tabular-nums">{transcript.trim().length}</span> chars
          </p>
          <Button
            className="ml-auto"
            onClick={() => void generate()}
            disabled={transcript.trim().length < 20 || generating}
          >
            {generating ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {generating ? "Writing…" : "Generate notes"}
          </Button>
        </div>

        {genError && (
          <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{genError}</p>
        )}
      </motion.div>

      {/* Live streaming preview */}
      {generating && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface2"
        >
          <div className="flex items-center gap-3 border-b border-line px-5 py-3">
            <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
            <p className="truncate text-sm font-medium text-ink">
              {statusLabel ?? "Working…"}
            </p>
          </div>
          <div className="max-h-[26rem] overflow-auto scrollbar-thin px-5 py-4">
            {draft ? (
              <MarkdownMessage content={draft} />
            ) : (
              <p className="text-sm text-muted">Reading the transcript…</p>
            )}
          </div>
        </motion.div>
      )}

      {/* Recent notes */}
      <div className="mt-10">
        <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wider text-muted">
          Recent notes
        </h2>
        {isInitialLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-28 rounded-xl" />
            ))}
          </div>
        ) : notes.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-12 text-center">
            <div className="grid size-11 place-items-center rounded-2xl bg-accent/10">
              <NotebookPen className="size-5 text-accent" />
            </div>
            <p className="text-sm font-medium text-ink">No notes yet</p>
            <p className="max-w-xs text-xs text-muted">
              Paste a transcript above — your structured notes show up here and in
              your Library.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {notes.map((note, i) => (
              <NoteCard key={note.id} note={note} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function NoteCard({ note, index }: { note: ArtifactSummary; index: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.25) }}
    >
      <Link
        to={`/tools/docs/${note.id}`}
        className="group flex h-full flex-col rounded-xl border border-line bg-surface2 p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg"
      >
        <div className="mb-2 flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg bg-accent/10 text-accent">
            <NotebookPen className="size-4" />
          </div>
          {note.parent_id && (
            <span className="rounded-full bg-black/10 px-2 py-0.5 text-[10px] font-medium text-muted dark:bg-white/10">
              revision
            </span>
          )}
        </div>
        <p className="line-clamp-2 flex-1 text-sm font-medium text-ink group-hover:text-accent">
          {note.title || "Untitled notes"}
        </p>
        <p className="mt-2 text-[11px] text-muted">{timeAgo(note.created_at)}</p>
      </Link>
    </motion.div>
  );
}
