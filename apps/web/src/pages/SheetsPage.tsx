// /tools/sheets — AI Sheets home. A "New sheet" panel (prompt + row-count
// slider + optional columns hint + optional hub grounding) streams
// streamGenerate("sheet") INLINE with a live preview: the schema delta
// renders the header row immediately, then each row delta appends for a
// streaming spreadsheet feel; on the terminal artifact event it navigates
// to the sheet editor (/tools/sheets/:id). Below is a gallery of existing
// kind=sheet artifacts.

import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowLeft,
  FolderKanban,
  Loader2,
  Sparkles,
  Table2,
  Trash2,
} from "lucide-react";
import { useApi, authFetch, invalidateApiPrefix } from "@/lib/use-api";
import { streamGenerate } from "@/lib/generate";
import type { ArtifactSummary, Hub } from "@/lib/types";
import {
  SHEET_COLUMN_TYPES,
  cellToDisplay,
  type SheetCell,
  type SheetColumn,
} from "@/lib/sheet-types";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { GeneratorSkillsStrip } from "@/components/skills/GeneratorSkillsStrip";
import type { GenTemplate } from "@/lib/templates";

const LIST_PATH = "/api/artifacts?kind=sheet&limit=50";
const NO_HUB = "__none__";
const MIN_ROWS = 3;
const MAX_ROWS = 200;

interface SchemaPreview {
  title: string;
  columns: SheetColumn[];
}

/** The schema delta arrives as a plain object (server emits it unserialized). */
function asSchemaPreview(data: unknown): SchemaPreview | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { title?: unknown; columns?: unknown };
  if (!Array.isArray(d.columns) || d.columns.length === 0) return null;
  const columns: SheetColumn[] = (d.columns as Array<Record<string, unknown>>)
    .filter((c) => c && typeof c === "object" && typeof c.name === "string")
    .map((c) => ({
      name: String(c.name),
      type: (SHEET_COLUMN_TYPES as readonly string[]).includes(String(c.type))
        ? (c.type as SheetColumn["type"])
        : "text",
    }));
  if (columns.length === 0) return null;
  return { title: typeof d.title === "string" ? d.title : "New sheet", columns };
}

export default function SheetsPage() {
  const navigate = useNavigate();
  const { data, isInitialLoading } = useApi<{ artifacts: ArtifactSummary[] }>(LIST_PATH);
  const sheets = data?.artifacts ?? [];
  const { data: hubsData } = useApi<{ hubs: Hub[] }>("/api/hubs");
  const hubs = hubsData?.hubs ?? [];

  const [prompt, setPrompt] = useState("");
  const [rowCount, setRowCount] = useState(12);
  const [columnsHint, setColumnsHint] = useState("");
  const [hubId, setHubId] = useState<string>(NO_HUB);

  const [generating, setGenerating] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [schema, setSchema] = useState<SchemaPreview | null>(null);
  const [previewRows, setPreviewRows] = useState<SheetCell[][]>([]);
  const [genError, setGenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Template → prefill the form (prompt + row count) and focus it so the user
  // can tweak before generating (Genspark "Add & Use").
  function useTemplate(t: GenTemplate) {
    if (generating) return;
    setPrompt(t.prompt);
    if (typeof t.extra?.rows_hint === "number") setRowCount(t.extra.rows_hint);
    setColumnsHint("");
    setGenError(null);
    requestAnimationFrame(() => {
      promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      promptRef.current?.focus();
    });
  }

  // Skill → seed the prompt (row count / columns hint stay as configured) and
  // focus the form, mirroring the template "Add & Use".
  function seedPrompt(seeded: string) {
    if (generating) return;
    setPrompt(seeded);
    setGenError(null);
    requestAnimationFrame(() => {
      promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      promptRef.current?.focus();
    });
  }

  async function generate() {
    const trimmed = prompt.trim();
    if (!trimmed || generating) return;
    setGenerating(true);
    setGenError(null);
    setSchema(null);
    setPreviewRows([]);
    setStatusLabel("Starting…");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamGenerate({
        name: "sheet",
        body: {
          prompt: trimmed,
          rows_hint: rowCount,
          ...(columnsHint.trim() ? { columns_hint: columnsHint.trim() } : {}),
          ...(hubId === NO_HUB ? {} : { hub_id: hubId }),
        },
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") {
            setStatusLabel(e.label);
          } else if (e.type === "delta" && e.channel === "schema") {
            setSchema(asSchemaPreview(e.data));
          } else if (e.type === "delta" && e.channel === "row") {
            const cells = e.data as unknown;
            if (Array.isArray(cells)) {
              setPreviewRows((rows) => [...rows, cells as SheetCell[]]);
            }
          } else if (e.type === "artifact") {
            void invalidateApiPrefix("/api/artifacts");
            navigate(`/tools/sheets/${e.artifact.id}`);
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
          Build data with <span className="grad-word">AI Sheets</span>
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
          Describe the data you need — Omni designs typed columns and fills
          the rows, streaming into an editable spreadsheet.
        </p>
      </div>

      {/* New sheet panel */}
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="rounded-2xl border border-line bg-gradient-to-b from-accent/[0.05] to-transparent p-5"
      >
        <div className="mb-3 flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent2 text-white shadow-sm">
            <Table2 className="size-4" />
          </div>
          <h2 className="font-display text-base font-semibold text-ink">New sheet</h2>
        </div>

        <Textarea
          ref={promptRef}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void generate();
            }
          }}
          placeholder="What data do you need? e.g. “Comparison of the 15 most popular JS frameworks: name, GitHub stars, first release, bundle size, official site”"
          rows={3}
          maxLength={4000}
          disabled={generating}
          className="bg-surface2"
        />

        <div className="mt-3 flex flex-wrap items-end gap-4">
          {/* Row-count slider */}
          <label className="flex w-52 flex-col gap-1.5 text-xs font-medium text-muted">
            <span>
              Rows{" "}
              <span className="font-semibold tabular-nums text-ink">{rowCount}</span>
            </span>
            <input
              type="range"
              min={MIN_ROWS}
              max={MAX_ROWS}
              value={rowCount}
              onChange={(e) => setRowCount(Number(e.target.value))}
              disabled={generating}
              aria-label="Row count"
              className="h-9 w-full cursor-pointer accent-accent disabled:opacity-60"
            />
          </label>

          {/* Columns hint */}
          <label className="flex min-w-56 flex-1 flex-col gap-1.5 text-xs font-medium text-muted">
            <span>
              Columns <span className="font-normal">(optional)</span>
            </span>
            <Input
              value={columnsHint}
              onChange={(e) => setColumnsHint(e.target.value)}
              placeholder="e.g. name, price, release date, link"
              maxLength={500}
              disabled={generating}
            />
          </label>

          {/* Hub grounding */}
          <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
            Ground in a hub <span className="font-normal">(optional)</span>
            <Select value={hubId} onValueChange={setHubId} disabled={generating}>
              <SelectTrigger className="h-9 w-48" aria-label="Hub">
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

          <Button
            className="ml-auto"
            onClick={() => void generate()}
            disabled={!prompt.trim() || generating}
          >
            {generating ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {generating ? "Generating…" : "Generate sheet"}
          </Button>
        </div>

        {genError && (
          <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{genError}</p>
        )}
      </motion.div>

      {/* Live streaming preview */}
      {generating && (
        <LivePreview
          statusLabel={statusLabel}
          schema={schema}
          rows={previewRows}
          total={rowCount}
        />
      )}

      {/* Skills that target sheets — seed the prompt above */}
      <GeneratorSkillsStrip output="sheet" onUse={seedPrompt} />

      {/* Template gallery */}
      <TemplateGallery kind="sheet" onUse={useTemplate} />

      {/* Existing sheets */}
      <div className="mt-8">
        <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wider text-muted">
          Your sheets
        </h2>
        {isInitialLoading ? (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[16/10] w-full rounded-xl" />
            ))}
          </div>
        ) : sheets.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-14 text-center">
            <div className="grid size-11 place-items-center rounded-2xl bg-accent/10">
              <Table2 className="size-5 text-accent" />
            </div>
            <p className="text-sm font-medium text-ink">No sheets yet</p>
            <p className="max-w-xs text-xs text-muted">
              Describe the data above — Omni designs the columns, then fills
              every row for you.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {sheets.map((sheet, i) => (
              <SheetCard key={sheet.id} sheet={sheet} index={i} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Live streaming preview ─────────────────────────────────────────

function LivePreview({
  statusLabel,
  schema,
  rows,
  total,
}: {
  statusLabel: string | null;
  schema: SchemaPreview | null;
  rows: SheetCell[][];
  total: number;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Keep the newest rows in view as they stream in.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [rows.length]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface2"
    >
      <div className="flex items-center gap-3 border-b border-line px-5 py-3">
        <Loader2 className="size-4 shrink-0 animate-spin text-accent" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">
            {schema?.title ?? "Designing your sheet"}
          </p>
          <p className="truncate text-xs text-muted">{statusLabel ?? "Working…"}</p>
        </div>
        <span className="shrink-0 text-xs font-semibold tabular-nums text-muted">
          {Math.min(rows.length, total)} / {total}
        </span>
      </div>

      {schema && (
        <div ref={bodyRef} className="max-h-72 overflow-auto scrollbar-thin">
          {/* border-separate keeps header borders attached while sticky. */}
          <table className="w-full min-w-max border-separate border-spacing-0 text-left text-sm">
            <thead className="sticky top-0 z-10 bg-surface2">
              <tr>
                {schema.columns.map((col, i) => (
                  <th
                    key={i}
                    className="whitespace-nowrap border-b border-line px-3 py-2 font-medium text-ink"
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {col.name}
                      <span className="rounded border border-line px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted">
                        {col.type}
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, ri) => (
                <motion.tr key={ri} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                  {schema.columns.map((col, ci) => (
                    <td
                      key={ci}
                      className={cn(
                        "max-w-56 truncate border-b border-line/60 px-3 py-1.5 text-muted",
                        col.type === "number" && "text-right tabular-nums",
                      )}
                    >
                      {cellToDisplay(row[ci] ?? null)}
                    </td>
                  ))}
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="h-1 w-full bg-accent/10" aria-hidden>
        <div
          className="h-full bg-gradient-to-r from-accent to-accent2 transition-all duration-500"
          style={{
            width: `${total > 0 ? Math.round((Math.min(rows.length, total) / total) * 100) : 5}%`,
          }}
        />
      </div>
    </motion.div>
  );
}

// ─── Sheet gallery card ─────────────────────────────────────────────

function SheetCard({ sheet, index }: { sheet: ArtifactSummary; index: number }) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const rowCount = typeof sheet.meta?.rows === "number" ? (sheet.meta.rows as number) : null;
  const colCount =
    typeof sheet.meta?.columns === "number" ? (sheet.meta.columns as number) : null;

  async function remove(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const ok = await confirm({
      title: "Delete sheet?",
      message: <>“{sheet.title || "Untitled"}” will be permanently removed.</>,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await authFetch(`/api/artifacts/${sheet.id}`, { method: "DELETE" });
      void invalidateApiPrefix("/api/artifacts");
    } finally {
      setBusy(false);
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.25) }}
    >
      <Link
        to={`/tools/sheets/${sheet.id}`}
        className="group block overflow-hidden rounded-xl border border-line bg-surface2 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg"
      >
        {/* Faux-grid cover */}
        <div className="relative aspect-[16/9] overflow-hidden bg-gradient-to-br from-accent/[0.08] via-surface2 to-accent2/[0.08]">
          <div className="absolute inset-x-4 top-4 grid grid-cols-4 gap-px overflow-hidden rounded-md border border-line/80 bg-line/60">
            {Array.from({ length: 16 }).map((_, i) => (
              <div
                key={i}
                className={cn(
                  "h-4",
                  i < 4 ? "bg-accent/15" : "bg-surface",
                )}
              />
            ))}
          </div>
          <Table2 className="absolute bottom-3 right-3 size-5 text-accent/40" />
          {sheet.parent_id && (
            <span className="absolute right-3 top-3 rounded-full bg-black/40 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur">
              revision
            </span>
          )}
          <button
            type="button"
            onClick={(e) => void remove(e)}
            disabled={busy}
            aria-label={`Delete ${sheet.title || "sheet"}`}
            className="absolute bottom-3 left-3 grid size-7 place-items-center rounded-md bg-black/40 text-white opacity-0 backdrop-blur transition hover:bg-rose-500/80 group-hover:opacity-100"
          >
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
          </button>
        </div>
        {/* Meta */}
        <div className="px-3 py-2.5">
          <p className="truncate text-sm font-medium text-ink group-hover:text-accent">
            {sheet.title || "Untitled sheet"}
          </p>
          <div className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
            {rowCount != null && colCount != null && (
              <>
                <span>
                  {rowCount} rows × {colCount} cols
                </span>
                <span>·</span>
              </>
            )}
            <span className="ml-auto">{timeAgo(sheet.created_at)}</span>
          </div>
        </div>
      </Link>
    </motion.div>
  );
}
