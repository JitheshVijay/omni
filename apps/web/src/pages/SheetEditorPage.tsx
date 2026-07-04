// /tools/sheets/:artifactId — spreadsheet viewer + editor. Loads the
// kind=sheet artifact (content is SheetContent {columns, rows}), renders it
// in a headless TanStack Table v8 grid with sortable typed columns and
// editable cells (double-click → input, Enter/blur commits, Escape cancels),
// dirty tracking + Save (PATCH content), add/delete-row affordances, and a
// toolbar: rename (PATCH on blur), Export CSV (hand-rolled, BOM + CRLF),
// Export .xlsx (exceljs in the browser, typed cells + bold header), "Edit
// with AI" (streamRevise → navigate to the new revision), Export to Drive
// (sheets have no server blob, so the CSV is built client-side and uploaded
// via POST /api/drive/files multipart — same pattern as DeckEditorPage's
// .pptx export), and Delete.
//
// Grids >300 rows render a simple windowed slice (no virtualization lib) —
// plain rows are fine at this scale. The load is StrictMode-safe (cancelled
// flag on the effect, mirroring DeckEditorPage / DocEditorPage).

import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  HardDriveUpload,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Save,
  Table2,
  Trash2,
  WandSparkles,
} from "lucide-react";
import { authFetch, invalidateApiPrefix } from "@/lib/use-api";
import { streamRevise } from "@/lib/generate";
import type { Artifact, ArtifactSummary } from "@/lib/types";
import {
  asSheet,
  buildCsv,
  cellToDisplay,
  coerceCellInput,
  isHttpUrl,
  type SheetCell,
  type SheetColumn,
} from "@/lib/sheet-types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

type Phase = "loading" | "ready" | "error";

const WINDOW = 300;
const CSV_MIME = "text/csv;charset=utf-8";
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface GridRow {
  /** Index into the underlying rows state — stable across sorting. */
  idx: number;
  cells: SheetCell[];
}

function safeName(title: string): string {
  return (title || "sheet").replace(/[^\w\s-]/g, "").trim().slice(0, 60) || "sheet";
}

/** Worksheet tab names: max 31 chars, no []:*?/\ characters. */
function sheetTabName(title: string): string {
  return title.replace(/[[\]:*?/\\]/g, "").trim().slice(0, 31) || "Sheet1";
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export default function SheetEditorPage() {
  // Match the tool-route convention (/tools/sheets/:artifactId) but tolerate
  // a ":id" param name too, so the page works however the route is wired.
  const params = useParams<{ artifactId?: string; id?: string }>();
  const routeId = params.artifactId ?? params.id;
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [phase, setPhase] = useState<Phase>("loading");
  const [columns, setColumns] = useState<SheetColumn[]>([]);
  const [rows, setRows] = useState<SheetCell[][]>([]);
  const [title, setTitle] = useState("");
  const [artifactId, setArtifactId] = useState<string | null>(routeId ?? null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportedToDrive, setExportedToDrive] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [windowStart, setWindowStart] = useState(0);
  const savedTitleRef = useRef("");

  // ── Load on :id (StrictMode-safe) ──────────────────────────────────────
  useEffect(() => {
    if (!routeId) return;
    let cancelled = false;
    setPhase("loading");
    setPageError(null);
    setActionError(null);
    setExportedToDrive(false);
    setSorting([]);
    setWindowStart(0);
    setArtifactId(routeId);
    (async () => {
      try {
        const art = await authFetch<Artifact>(`/api/artifacts/${routeId}`);
        if (cancelled) return;
        const sheet = asSheet(art.content);
        if (!sheet) {
          setPageError("This sheet is empty or has an unexpected format.");
          setPhase("error");
          return;
        }
        setColumns(sheet.columns);
        setRows(sheet.rows);
        setTitle(art.title ?? "");
        savedTitleRef.current = art.title ?? "";
        setDirty(false);
        setPhase("ready");
      } catch (err) {
        if (cancelled) return;
        setPageError(err instanceof Error ? err.message : "Could not load this sheet.");
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [routeId]);

  // ── Grid model (TanStack Table v8, headless) ───────────────────────────
  const data = useMemo<GridRow[]>(
    () => rows.map((cells, idx) => ({ idx, cells })),
    [rows],
  );
  const tableColumns = useMemo<ColumnDef<GridRow>[]>(
    () =>
      columns.map((col, i) => ({
        id: `c${i}`,
        // null → undefined so sortUndefined keeps blanks together at the end.
        accessorFn: (row: GridRow) => row.cells[i] ?? undefined,
        sortingFn: col.type === "number" ? "basic" : "alphanumeric",
        sortUndefined: "last" as const,
      })),
    [columns],
  );
  const table = useReactTable({
    data,
    columns: tableColumns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });

  const orderedRows = table.getRowModel().rows;
  const windowed =
    orderedRows.length > WINDOW
      ? orderedRows.slice(windowStart, windowStart + WINDOW)
      : orderedRows;

  // Keep the window slice valid as sorting/row-count change.
  useEffect(() => setWindowStart(0), [sorting]);
  useEffect(() => {
    setWindowStart((s) => (s >= rows.length ? Math.max(0, rows.length - WINDOW) : s));
  }, [rows.length]);

  // ── Cell / row edits ────────────────────────────────────────────────────
  function updateCell(rowIdx: number, colIdx: number, next: SheetCell) {
    const current = rows[rowIdx]?.[colIdx] ?? null;
    if (current === next) return;
    setRows((prev) => {
      const copy = prev.slice();
      const cells = (copy[rowIdx] ?? []).slice();
      cells[colIdx] = next;
      copy[rowIdx] = cells;
      return copy;
    });
    setDirty(true);
  }

  function addRow() {
    // Clear sorting so the new row is visibly appended at the bottom.
    setSorting([]);
    setRows([...rows, columns.map(() => null)]);
    setWindowStart(Math.max(0, rows.length + 1 - WINDOW));
    setDirty(true);
  }

  function deleteRow(rowIdx: number) {
    setRows((prev) => prev.filter((_, i) => i !== rowIdx));
    setDirty(true);
  }

  // ── Save (content PATCH) ────────────────────────────────────────────────
  async function save() {
    if (!artifactId || !dirty || saving) return;
    setSaving(true);
    setActionError(null);
    try {
      await authFetch(`/api/artifacts/${artifactId}`, {
        method: "PATCH",
        body: JSON.stringify({ content: { columns, rows } }),
      });
      setDirty(false);
      void invalidateApiPrefix("/api/artifacts");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  }

  // Cmd/Ctrl+S — registered once, dispatching through a ref to avoid a
  // stale closure over rows/dirty.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void saveRef.current();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  async function saveTitle() {
    const t = title.trim() || "Untitled sheet";
    if (!artifactId || t === savedTitleRef.current) return;
    try {
      await authFetch(`/api/artifacts/${artifactId}`, {
        method: "PATCH",
        body: JSON.stringify({ title: t }),
      });
      savedTitleRef.current = t;
      void invalidateApiPrefix("/api/artifacts");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Rename failed.");
    }
  }

  // ── Exports ─────────────────────────────────────────────────────────────
  function exportCsv() {
    downloadBlob(
      new Blob([buildCsv(columns, rows)], { type: CSV_MIME }),
      `${safeName(title)}.csv`,
    );
  }

  async function exportXlsx() {
    if (exporting) return;
    setExporting(true);
    setActionError(null);
    try {
      // exceljs is heavy — load it only when the export is requested.
      const { Workbook } = await import("exceljs");
      const wb = new Workbook();
      const ws = wb.addWorksheet(sheetTabName(title));
      ws.addRow(columns.map((c) => c.name));
      ws.getRow(1).font = { bold: true };
      for (const r of rows) {
        ws.addRow(
          columns.map((c, i) => {
            const v = r[i] ?? null;
            if (v === null) return null;
            if (c.type === "number" && typeof v === "number") return v;
            if (c.type === "url" && isHttpUrl(v)) {
              return { text: v, hyperlink: v };
            }
            return v;
          }),
        );
      }
      columns.forEach((c, i) => {
        const maxLen = Math.max(
          c.name.length,
          ...rows.slice(0, 200).map((r) => cellToDisplay(r[i] ?? null).length),
        );
        ws.getColumn(i + 1).width = Math.min(48, Math.max(10, maxLen + 2));
      });
      const buf = await wb.xlsx.writeBuffer();
      downloadBlob(new Blob([buf], { type: XLSX_MIME }), `${safeName(title)}.xlsx`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Could not build the .xlsx.");
    } finally {
      setExporting(false);
    }
  }

  async function exportToDrive() {
    setActionError(null);
    try {
      const file = new File([buildCsv(columns, rows)], `${safeName(title)}.csv`, {
        type: "text/csv",
      });
      const fd = new FormData();
      fd.append("file", file);
      await authFetch(`/api/drive/files`, { method: "POST", body: fd });
      void invalidateApiPrefix("/api/drive/files");
      setExportedToDrive(true);
      setTimeout(() => setExportedToDrive(false), 2500);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Export to Drive failed.");
    }
  }

  async function removeSheet() {
    if (!artifactId) return;
    const ok = await confirm({
      title: "Delete sheet?",
      message: <>“{title || "Untitled"}” will be permanently removed.</>,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await authFetch(`/api/artifacts/${artifactId}`, { method: "DELETE" });
      void invalidateApiPrefix("/api/artifacts");
      navigate("/tools/sheets");
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  // Revisions run against the SAVED content — flush pending edits first.
  async function openEdit() {
    if (dirty) await save();
    setEditOpen(true);
  }

  // ── Error phase ─────────────────────────────────────────────────────────
  if (phase === "error") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Table2 className="size-10 text-muted/50" />
        <p className="font-display text-lg font-semibold text-ink">
          Couldn't open this sheet
        </p>
        <p className="max-w-sm text-sm text-muted">{pageError}</p>
        <Button variant="secondary" asChild>
          <Link to="/tools/sheets">Back to Sheets</Link>
        </Button>
      </div>
    );
  }

  const ready = phase === "ready";

  return (
    <div className="flex h-screen min-h-0 flex-col">
      {/* Toolbar */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2.5 md:px-6">
        <Button variant="ghost" size="iconSm" asChild aria-label="Back to Sheets">
          <Link to="/tools/sheets">
            <ArrowLeft />
          </Link>
        </Button>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => void saveTitle()}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          disabled={!ready}
          placeholder="Untitled sheet"
          aria-label="Sheet title"
          className="min-w-0 flex-1 truncate rounded-md bg-transparent px-2 py-1 font-display text-sm font-semibold text-ink outline-none transition placeholder:text-muted hover:bg-ink/[0.03] focus:bg-ink/[0.04] focus:ring-2 focus:ring-accent/30 md:text-base"
        />

        {/* Dirty / saved indicator */}
        <span
          className="hidden shrink-0 items-center gap-1.5 text-xs text-muted sm:inline-flex"
          aria-live="polite"
        >
          {saving ? (
            <>
              <Loader2 className="size-3 animate-spin" /> Saving…
            </>
          ) : dirty ? (
            <>
              <span className="size-1.5 rounded-full bg-amber-500" /> Unsaved
            </>
          ) : (
            <>
              <Check className="size-3 text-emerald-500" /> Saved
            </>
          )}
        </span>

        <Button size="sm" onClick={() => void save()} disabled={!ready || !dirty || saving}>
          {saving ? <Loader2 className="animate-spin" /> : <Save />}
          Save
        </Button>

        <Button size="sm" variant="secondary" onClick={exportCsv} disabled={!ready}>
          <Download />
          Export CSV
        </Button>

        <Button size="sm" variant="secondary" onClick={() => void openEdit()} disabled={!ready}>
          <WandSparkles />
          Edit with AI
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="iconSm" variant="ghost" aria-label="More actions">
              {exportedToDrive ? (
                <Check className="text-emerald-500" />
              ) : exporting ? (
                <Loader2 className="animate-spin" />
              ) : (
                <MoreHorizontal />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void exportXlsx()} disabled={!ready || exporting}>
              <Download />
              Export .xlsx
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void exportToDrive()} disabled={!ready}>
              <HardDriveUpload />
              Export to Drive
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-rose-600 focus:text-rose-600 dark:text-rose-400"
              onSelect={() => void removeSheet()}
              disabled={!artifactId}
            >
              <Trash2 />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      {actionError && (
        <p className="border-b border-rose-500/20 bg-rose-500/[0.06] px-6 py-1.5 text-xs text-rose-600 dark:text-rose-400">
          {actionError}
        </p>
      )}

      {/* Body */}
      {!ready ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-6 md:p-8">
          <Skeleton className="h-9 w-full rounded-lg" />
          {Array.from({ length: 10 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full rounded-md" />
          ))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
            {/* border-separate keeps cell borders attached to the sticky
                header (border-collapse borders detach while scrolling). */}
            <table className="w-full min-w-max border-separate border-spacing-0 text-left text-sm">
              <thead className="sticky top-0 z-10 bg-surface2">
                <tr>
                  <th className="w-10 border-b border-r border-line px-2 py-2 text-right text-[11px] font-medium tabular-nums text-muted">
                    #
                  </th>
                  {table.getHeaderGroups()[0]?.headers.map((header, i) => {
                    const col = columns[i];
                    const sorted = header.column.getIsSorted();
                    return (
                      <th key={header.id} className="border-b border-r border-line p-0 last:border-r-0">
                        <button
                          type="button"
                          onClick={header.column.getToggleSortingHandler()}
                          className="group flex w-full items-center gap-1.5 px-3 py-2 text-left font-medium text-ink transition hover:bg-ink/[0.03]"
                          aria-label={`Sort by ${col.name}`}
                        >
                          <span className="truncate">{col.name}</span>
                          <span className="rounded border border-line px-1 py-px text-[9px] font-semibold uppercase tracking-wide text-muted">
                            {col.type}
                          </span>
                          {sorted === "asc" ? (
                            <ArrowUp className="ml-auto size-3.5 shrink-0 text-accent" />
                          ) : sorted === "desc" ? (
                            <ArrowDown className="ml-auto size-3.5 shrink-0 text-accent" />
                          ) : (
                            <ArrowUpDown className="ml-auto size-3.5 shrink-0 text-muted/0 transition group-hover:text-muted/60" />
                          )}
                        </button>
                      </th>
                    );
                  })}
                  <th className="w-9 border-b border-line" aria-label="Row actions" />
                </tr>
              </thead>
              <tbody>
                {windowed.map((row) => (
                  <tr key={row.original.idx} className="group hover:bg-ink/[0.02]">
                    <td className="border-b border-r border-line/60 px-2 py-1.5 text-right text-[11px] tabular-nums text-muted">
                      {row.original.idx + 1}
                    </td>
                    {columns.map((col, ci) => (
                      <td
                        key={ci}
                        className="max-w-72 border-b border-r border-line/60 p-0 last:border-r-0"
                      >
                        <EditableCell
                          value={row.original.cells[ci] ?? null}
                          type={col.type}
                          onCommit={(next) => updateCell(row.original.idx, ci, next)}
                        />
                      </td>
                    ))}
                    <td className="w-9 border-b border-line/60 px-1 text-center">
                      <button
                        type="button"
                        onClick={() => deleteRow(row.original.idx)}
                        aria-label={`Delete row ${row.original.idx + 1}`}
                        className="grid size-6 place-items-center rounded-md text-muted/0 transition hover:bg-rose-500/10 hover:text-rose-500 group-hover:text-muted/60"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="px-4 py-2">
              <Button size="sm" variant="ghost" onClick={addRow} className="text-muted">
                <Plus />
                Add row
              </Button>
            </div>
          </div>

          {/* Footer: counts + window controls */}
          <footer className="flex shrink-0 items-center gap-3 border-t border-line bg-surface px-4 py-1.5 text-xs text-muted md:px-6">
            <span className="tabular-nums">
              {rows.length} rows × {columns.length} columns
            </span>
            {orderedRows.length > WINDOW && (
              <span className="ml-auto inline-flex items-center gap-1 tabular-nums">
                <button
                  type="button"
                  onClick={() => setWindowStart((s) => Math.max(0, s - WINDOW))}
                  disabled={windowStart === 0}
                  aria-label="Previous rows"
                  className="grid size-6 place-items-center rounded-md transition hover:bg-ink/5 hover:text-ink disabled:opacity-40"
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                Rows {windowStart + 1}–{Math.min(windowStart + WINDOW, orderedRows.length)} of{" "}
                {orderedRows.length}
                <button
                  type="button"
                  onClick={() =>
                    setWindowStart((s) =>
                      Math.min(s + WINDOW, Math.max(0, orderedRows.length - WINDOW)),
                    )
                  }
                  disabled={windowStart + WINDOW >= orderedRows.length}
                  aria-label="Next rows"
                  className="grid size-6 place-items-center rounded-md transition hover:bg-ink/5 hover:text-ink disabled:opacity-40"
                >
                  <ChevronRight className="size-3.5" />
                </button>
              </span>
            )}
          </footer>
        </div>
      )}

      <EditWithAiDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        artifactId={artifactId}
        onDone={(a) => {
          setEditOpen(false);
          navigate(`/tools/sheets/${a.id}`);
        }}
      />
    </div>
  );
}

// ── Editable cell ──────────────────────────────────────────────────────────
// Double-click → input; Enter/blur commits, Escape cancels. Type-aware
// presentation: numbers right-aligned tabular, dates mono-ish, urls render
// as links with a hover pencil as the edit affordance (clicking the link
// navigates, so double-click alone would fight it).

function EditableCell({
  value,
  type,
  onCommit,
}: {
  value: SheetCell;
  type: SheetColumn["type"];
  onCommit: (next: SheetCell) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  function start() {
    setDraft(cellToDisplay(value));
    setEditing(true);
  }

  function commit() {
    setEditing(false);
    onCommit(coerceCellInput(draft, type));
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setEditing(false); // cancel — no commit
          }
        }}
        inputMode={type === "number" ? "decimal" : undefined}
        aria-label="Edit cell"
        className={cn(
          "w-full bg-surface px-3 py-1.5 text-sm text-ink outline-none ring-2 ring-inset ring-accent/60",
          type === "number" && "text-right tabular-nums",
        )}
      />
    );
  }

  if (type === "url" && isHttpUrl(value)) {
    return (
      <div className="group/cell flex items-center gap-1 px-3 py-1.5" onDoubleClick={start}>
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="inline-flex min-w-0 items-center gap-1 truncate text-accent hover:underline"
          title={value}
        >
          <span className="truncate">{value.replace(/^https?:\/\/(www\.)?/i, "")}</span>
          <ExternalLink className="size-3 shrink-0 opacity-60" />
        </a>
        <button
          type="button"
          onClick={start}
          aria-label="Edit link"
          className="ml-auto grid size-5 shrink-0 place-items-center rounded text-muted/0 transition hover:bg-ink/5 hover:text-ink group-hover/cell:text-muted/70"
        >
          <Pencil className="size-3" />
        </button>
      </div>
    );
  }

  return (
    <div
      onDoubleClick={start}
      title="Double-click to edit"
      className={cn(
        "cursor-cell truncate px-3 py-1.5",
        value === null ? "text-muted/40" : "text-ink",
        type === "number" && "text-right tabular-nums",
        type === "date" && "whitespace-nowrap text-ink/80",
      )}
    >
      {value === null ? "—" : cellToDisplay(value)}
    </div>
  );
}

// ── Edit with AI dialog ────────────────────────────────────────────────────

function EditWithAiDialog({
  open,
  onOpenChange,
  artifactId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  artifactId: string | null;
  onDone: (artifact: ArtifactSummary) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const [revising, setRevising] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (open) {
      setInstruction("");
      setError(null);
      setStatus(null);
    } else {
      abortRef.current?.abort();
      setRevising(false);
    }
  }, [open]);

  async function revise() {
    if (!artifactId || !instruction.trim() || revising) return;
    setRevising(true);
    setError(null);
    setStatus("Starting…");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamRevise({
        artifactId,
        instruction: instruction.trim(),
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") setStatus(e.label);
          else if (e.type === "artifact") {
            void invalidateApiPrefix("/api/artifacts");
            onDone(e.artifact);
          } else if (e.type === "error") setError(e.message);
        },
      });
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setError(err instanceof Error ? err.message : "Revision failed.");
      }
    } finally {
      setRevising(false);
      setStatus(null);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !revising && onOpenChange(v)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <WandSparkles className="size-4 text-accent" />
            Edit with AI
          </DialogTitle>
          <DialogDescription>
            Describe the change — Omni rebuilds the sheet as a new revision
            (the original is kept).
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void revise();
          }}
        >
          <Textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder="e.g. “Add a Market Cap column and sort by it, largest first”"
            rows={3}
            maxLength={2000}
            autoFocus
            disabled={revising}
          />
          {error && <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={revising}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!instruction.trim() || revising}>
              {revising ? (
                <>
                  <Loader2 className="animate-spin" />
                  {status ?? "Revising…"}
                </>
              ) : (
                "Revise sheet"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
