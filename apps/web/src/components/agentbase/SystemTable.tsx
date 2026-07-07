// A single system TABLE rendered as a data grid: typed columns, one row per
// record, an inline "Add row" form driven by the column schema, and a per-row
// delete affordance. Mutations POST/DELETE through the agentbase client and
// then call onChanged() so the page can revalidate the system (which recomputes
// the dashboard tiles server-side).

import { useState } from "react";
import { Plus, Trash2, Loader2, X, Check, ExternalLink } from "lucide-react";
import {
  addRecord,
  deleteRecord,
  formatCell,
  type Column,
  type RecordData,
  type SystemTable as SystemTableModel,
} from "@/lib/agentbase";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function SystemTable({
  systemId,
  table,
  onChanged,
  onError,
}: {
  systemId: string;
  table: SystemTableModel;
  onChanged: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const columns = table.columns;

  function openAdd() {
    setDraft({});
    setAdding(true);
  }

  function cancelAdd() {
    setAdding(false);
    setDraft({});
  }

  async function submitAdd() {
    if (saving) return;
    // Require at least one filled cell so we don't create blank rows.
    const hasValue = Object.values(draft).some((v) => v.trim() !== "");
    if (!hasValue) {
      cancelAdd();
      return;
    }
    setSaving(true);
    try {
      const data: RecordData = {};
      for (const col of columns) {
        const v = draft[col.key];
        if (v !== undefined && v.trim() !== "") data[col.key] = v.trim();
      }
      await addRecord(systemId, table.id, data);
      setAdding(false);
      setDraft({});
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add that row.");
    } finally {
      setSaving(false);
    }
  }

  async function removeRow(recordId: string) {
    if (deletingId) return;
    setDeletingId(recordId);
    try {
      await deleteRecord(systemId, recordId);
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not delete that row.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface2 shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex items-baseline gap-2">
          <h3 className="font-display text-sm font-semibold text-ink">{table.name}</h3>
          <span className="text-xs text-muted">
            {table.records.length} row{table.records.length === 1 ? "" : "s"}
          </span>
        </div>
        {!adding && (
          <Button size="sm" variant="secondary" onClick={openAdd}>
            <Plus className="size-3.5" />
            Add row
          </Button>
        )}
      </div>

      {/* Grid */}
      <div className="overflow-x-auto scrollbar-thin">
        <table className="w-full min-w-[36rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="whitespace-nowrap px-4 py-2.5 text-left text-xs font-medium uppercase tracking-wider text-muted"
                >
                  {col.label}
                </th>
              ))}
              <th className="w-10 px-2" />
            </tr>
          </thead>
          <tbody>
            {table.records.map((rec) => (
              <tr
                key={rec.id}
                className="group border-b border-line/60 transition hover:bg-surface3/40"
              >
                {columns.map((col) => (
                  <td
                    key={col.key}
                    className="px-4 py-2.5 align-top text-ink/90"
                    style={
                      col.type === "number" || col.type === "currency"
                        ? { fontVariantNumeric: "tabular-nums" }
                        : undefined
                    }
                  >
                    <CellValue value={rec.data[col.key]} column={col} />
                  </td>
                ))}
                <td className="px-2 text-right">
                  <button
                    type="button"
                    onClick={() => removeRow(rec.id)}
                    disabled={deletingId === rec.id}
                    aria-label="Delete row"
                    className="grid size-7 place-items-center rounded-md text-muted opacity-0 transition hover:bg-rose-600/15 hover:text-rose-400 group-hover:opacity-100 focus-visible:opacity-100"
                  >
                    {deletingId === rec.id ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="size-3.5" />
                    )}
                  </button>
                </td>
              </tr>
            ))}

            {/* Inline add-row form */}
            {adding && (
              <tr className="border-b border-line bg-surface3/30">
                {columns.map((col, i) => (
                  <td key={col.key} className="px-2 py-2 align-top">
                    <CellInput
                      column={col}
                      value={draft[col.key] ?? ""}
                      autoFocus={i === 0}
                      onChange={(v) => setDraft((d) => ({ ...d, [col.key]: v }))}
                      onEnter={submitAdd}
                    />
                  </td>
                ))}
                <td className="px-2 align-top">
                  <div className="flex items-center gap-1 pt-1">
                    <button
                      type="button"
                      onClick={submitAdd}
                      disabled={saving}
                      aria-label="Save row"
                      className="grid size-7 place-items-center rounded-md bg-accent text-white transition hover:bg-accent/90 disabled:opacity-60"
                    >
                      {saving ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <Check className="size-3.5" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={cancelAdd}
                      disabled={saving}
                      aria-label="Cancel"
                      className="grid size-7 place-items-center rounded-md text-muted transition hover:bg-surface3 hover:text-ink"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            )}

            {table.records.length === 0 && !adding && (
              <tr>
                <td
                  colSpan={columns.length + 1}
                  className="px-4 py-10 text-center text-sm text-muted"
                >
                  No rows yet.{" "}
                  <button
                    type="button"
                    onClick={openAdd}
                    className="font-medium text-accent hover:underline"
                  >
                    Add the first one
                  </button>
                  .
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CellValue({ value, column }: { value: string | number | undefined; column: Column }) {
  const empty = value === undefined || value === null || value === "";
  if (empty) return <span className="text-muted/50">–</span>;

  if (column.type === "url") {
    const href = String(value);
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="inline-flex items-center gap-1 text-accent hover:underline"
      >
        <span className="max-w-[16rem] truncate">{href.replace(/^https?:\/\//, "")}</span>
        <ExternalLink className="size-3 shrink-0" />
      </a>
    );
  }
  if (column.type === "select") {
    return (
      <span className="inline-flex items-center rounded-full border border-line bg-surface3 px-2 py-0.5 text-xs font-medium text-ink/90">
        {String(value)}
      </span>
    );
  }
  return <span>{formatCell(value, column.type)}</span>;
}

function CellInput({
  column,
  value,
  autoFocus,
  onChange,
  onEnter,
}: {
  column: Column;
  value: string;
  autoFocus?: boolean;
  onChange: (v: string) => void;
  onEnter: () => void;
}) {
  if (column.type === "select" && column.options?.length) {
    return (
      <Select value={value || undefined} onValueChange={onChange}>
        <SelectTrigger className="h-8 w-full min-w-[8rem] text-xs">
          <SelectValue placeholder={column.label} />
        </SelectTrigger>
        <SelectContent>
          {column.options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const inputType =
    column.type === "date"
      ? "date"
      : column.type === "number" || column.type === "currency"
        ? "number"
        : column.type === "url"
          ? "url"
          : "text";

  return (
    <Input
      type={inputType}
      value={value}
      autoFocus={autoFocus}
      placeholder={column.label}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onEnter();
        }
      }}
      className="h-8 min-w-[8rem] text-xs"
    />
  );
}
