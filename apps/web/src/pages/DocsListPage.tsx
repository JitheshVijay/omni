// /tools/docs — AI Docs home: a "New document" panel (prompt + optional hub
// grounding + length) and the list of existing kind=doc artifacts. Generate
// navigates to /tools/docs/new with the request in router state; the editor
// page starts the stream (mirrors the ChatIndexPage → ChatThreadPage handoff).

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  FolderKanban,
  Loader2,
  PenLine,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useApi, authFetch, invalidateApiPrefix } from "@/lib/use-api";
import type { ArtifactSummary, Hub } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TemplateGallery } from "@/components/tools/TemplateGallery";
import type { GenTemplate } from "@/lib/templates";

const LIST_PATH = "/api/artifacts?kind=doc&limit=50";

export type DocLength = "short" | "medium" | "long";

// Handed to DocEditorPage (/tools/docs/new) via router state.
export interface DocGenNavState {
  prompt: string;
  hub_id?: string | null;
  length: DocLength;
}

const LENGTHS: { value: DocLength; label: string; hint: string }[] = [
  { value: "short", label: "Short", hint: "~400 words" },
  { value: "medium", label: "Medium", hint: "~1000 words" },
  { value: "long", label: "Long", hint: "~2000 words" },
];

const NO_HUB = "__none__";

export default function DocsListPage() {
  const navigate = useNavigate();
  const { data, isInitialLoading } = useApi<{ artifacts: ArtifactSummary[] }>(LIST_PATH);
  const docs = data?.artifacts ?? [];
  const { data: hubsData } = useApi<{ hubs: Hub[] }>("/api/hubs");
  const hubs = hubsData?.hubs ?? [];

  const [prompt, setPrompt] = useState("");
  const [hubId, setHubId] = useState<string>(NO_HUB);
  const [length, setLength] = useState<DocLength>("medium");

  function generate() {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    navigate("/tools/docs/new", {
      state: {
        prompt: trimmed,
        hub_id: hubId === NO_HUB ? null : hubId,
        length,
      } satisfies DocGenNavState,
    });
  }

  // Template → straight into the editor with the seeded prompt + length,
  // reusing the same router-state handoff as manual generation.
  function useTemplate(t: GenTemplate) {
    navigate("/tools/docs/new", {
      state: {
        prompt: t.prompt,
        hub_id: hubId === NO_HUB ? null : hubId,
        length: (t.extra?.length as DocLength) ?? "medium",
      } satisfies DocGenNavState,
    });
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
          Write anything with <span className="grad-word">AI Docs</span>
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
          Full documents, streamed into a rich editor — grounded in your hubs
          with inline citations.
        </p>
      </div>

      {/* New document panel */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="rounded-2xl border border-line bg-gradient-to-b from-accent/[0.05] to-transparent p-5"
      >
        <div className="mb-3 flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent2 text-white shadow-sm">
            <PenLine className="size-4" />
          </div>
          <h2 className="font-display text-base font-semibold text-ink">New document</h2>
        </div>
        <Textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              generate();
            }
          }}
          placeholder="What should Omni write? e.g. “A one-page project brief for the Q3 launch, covering goals, risks, and timeline”"
          rows={3}
          maxLength={8000}
          className="bg-surface2"
        />
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
            Ground in a hub <span className="font-normal">(optional — adds citations)</span>
            <Select value={hubId} onValueChange={setHubId}>
              <SelectTrigger className="h-9 w-56" aria-label="Hub">
                <FolderKanban className="size-3.5 shrink-0 text-muted" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_HUB}>No hub</SelectItem>
                {hubs.map((h) => (
                  <SelectItem key={h.id} value={h.id}>
                    {h.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          {/* Length segmented control */}
          <div className="flex flex-col gap-1.5 text-xs font-medium text-muted">
            Length
            <div className="flex rounded-lg border border-line bg-surface2 p-0.5 shadow-sm">
              {LENGTHS.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  onClick={() => setLength(l.value)}
                  title={l.hint}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium transition",
                    length === l.value
                      ? "bg-accent text-white shadow-sm"
                      : "text-muted hover:text-ink",
                  )}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </div>

          <Button className="ml-auto" onClick={generate} disabled={!prompt.trim()}>
            <Sparkles />
            Generate
          </Button>
        </div>
      </motion.div>

      {/* Template gallery */}
      <TemplateGallery kind="doc" onUse={useTemplate} />

      {/* Existing docs */}
      <div className="mt-8">
        <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wider text-muted">
          Your documents
        </h2>
        {isInitialLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-12 text-center">
            <div className="grid size-11 place-items-center rounded-2xl bg-accent/10">
              <FileText className="size-5 text-accent" />
            </div>
            <p className="text-sm font-medium text-ink">No documents yet</p>
            <p className="max-w-xs text-xs text-muted">
              Describe what you need above — the draft streams straight into an
              editable page.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface2">
            {docs.map((doc, i) => (
              <DocRow key={doc.id} doc={doc} index={i} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function DocRow({ doc, index }: { doc: ArtifactSummary; index: number }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const excerpt =
    typeof doc.meta?.prompt === "string" ? (doc.meta.prompt as string) : null;

  async function remove(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const ok = await confirm({
      title: "Delete document?",
      message: <>“{doc.title || "Untitled"}” will be permanently removed.</>,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await authFetch(`/api/artifacts/${doc.id}`, { method: "DELETE" });
      void invalidateApiPrefix("/api/artifacts");
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.li
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, delay: Math.min(index * 0.03, 0.25) }}
    >
      <Link
        to={`/tools/docs/${doc.id}`}
        className="group flex items-center gap-3 px-4 py-3 transition hover:bg-ink/[0.02]"
      >
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
          <FileText className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink group-hover:text-accent">
            {doc.title || "Untitled document"}
          </p>
          {excerpt && <p className="truncate text-xs text-muted">{excerpt}</p>}
        </div>
        {doc.parent_id && (
          <span className="hidden shrink-0 rounded-full border border-line bg-surface px-2 py-0.5 text-[10px] text-muted sm:inline">
            revision
          </span>
        )}
        <span className="shrink-0 text-[11px] text-muted">{timeAgo(doc.created_at)}</span>
        <button
          type="button"
          onClick={(e) => void remove(e)}
          disabled={busy}
          aria-label={`Delete ${doc.title || "document"}`}
          className="shrink-0 rounded-md p-1.5 text-muted opacity-0 transition hover:bg-rose-500/10 hover:text-rose-500 group-hover:opacity-100"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        </button>
        <ChevronRight className="size-4 shrink-0 text-muted/50 transition group-hover:translate-x-0.5 group-hover:text-accent" />
      </Link>
    </motion.li>
  );
}
