// /agentbase — AgentBase home ("Dashboards & CRM"). Turn a description into a
// custom "system" (a lightweight dashboard/CRM: typed tables + summary tiles),
// or clone one from the template gallery.
//
// Layout: a left rail with the italic hero, four "source" options (three are
// visual — clicking focuses the describe box with a hint — plus "Just describe
// it"), and a describe box + Create. The main area toggles between "My Systems"
// (the user's generated systems) and "All Templates" (the gallery), with
// category filter chips. Creating from a prompt POSTs {prompt}; using a template
// POSTs {from_template}; both navigate to /agentbase/:id.

import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Sparkles,
  Inbox,
  FileText,
  Blocks,
  PencilLine,
  ArrowRight,
  Loader2,
  Trash2,
  Table2,
  LayoutGrid,
} from "lucide-react";
import { useApi, invalidateApiPrefix } from "@/lib/use-api";
import {
  createSystem,
  createSystemFromFile,
  deleteSystem,
  SYSTEMS_KEY,
  TEMPLATES_KEY,
  AGENTBASE_CATEGORIES,
  type SystemSummary,
  type Template,
} from "@/lib/agentbase";
import { SystemIcon } from "@/components/agentbase/SystemIcon";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";

type Tab = "systems" | "templates";

const SOURCES: {
  id: string;
  label: string;
  hint: string;
  icon: typeof Inbox;
  describe?: boolean;
}[] = [
  {
    id: "inbox",
    label: "From your inbox",
    hint: "Describe the emails you want to track — e.g. “a CRM from my sales inbox with company, contact, and deal stage”.",
    icon: Inbox,
  },
  {
    id: "files",
    label: "From files",
    hint: "Describe the spreadsheet or docs — e.g. “an inventory tracker from my product list with SKU, stock, and reorder point”.",
    icon: FileText,
  },
  {
    id: "app",
    label: "From another app",
    hint: "Describe what to pull in — e.g. “a project tracker like my Notion board with task, owner, status, and due date”.",
    icon: Blocks,
  },
  {
    id: "describe",
    label: "Just describe it",
    hint: "",
    icon: PencilLine,
    describe: true,
  },
];

export default function AgentBasePage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const describeRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [prompt, setPrompt] = useState("");
  const [creating, setCreating] = useState(false);
  const [usingId, setUsingId] = useState<string | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("systems");
  const [category, setCategory] = useState<string | null>(null);

  const { data: systemsData, isInitialLoading: systemsLoading } = useApi<{
    systems: SystemSummary[];
  }>(SYSTEMS_KEY);
  const systems = systemsData?.systems ?? [];

  const { data: templatesData, isInitialLoading: templatesLoading } = useApi<{
    templates: Template[];
    categories: string[];
  }>(TEMPLATES_KEY);
  const templates = templatesData?.templates ?? [];

  // Default the tab to templates when the user has no systems yet.
  const effectiveTab: Tab =
    tab === "systems" && !systemsLoading && systems.length === 0 ? "templates" : tab;

  const filteredTemplates = useMemo(
    () => (category ? templates.filter((t) => t.category === category) : templates),
    [templates, category],
  );

  function focusDescribe(hint: string) {
    if (hint) setPrompt((p) => (p.trim() ? p : hint));
    requestAnimationFrame(() => describeRef.current?.focus());
  }

  // "From files" source: pick a CSV/TSV and let the server parse it into a real
  // system (typed columns + records + auto-suggested tiles), then open it.
  function handleSourceClick(source: (typeof SOURCES)[number]) {
    if (source.id === "files") {
      if (!importing) fileInputRef.current?.click();
      return;
    }
    focusDescribe(source.hint);
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file later
    if (!file || importing) return;
    setImporting(file.name);
    setError(null);
    try {
      const system = await createSystemFromFile(file);
      await invalidateApiPrefix(SYSTEMS_KEY);
      navigate(`/agentbase/${system.id}`);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not build a system from that file.",
      );
      setImporting(null);
    }
  }

  async function handleCreate() {
    const text = prompt.trim();
    if (!text || creating) return;
    setCreating(true);
    setError(null);
    try {
      const system = await createSystem({ prompt: text });
      await invalidateApiPrefix(SYSTEMS_KEY);
      navigate(`/agentbase/${system.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build that system.");
      setCreating(false);
    }
  }

  async function handleUseTemplate(t: Template) {
    if (usingId) return;
    setUsingId(t.id);
    setError(null);
    try {
      const system = await createSystem({ from_template: t.id });
      await invalidateApiPrefix(SYSTEMS_KEY);
      navigate(`/agentbase/${system.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not use that template.");
      setUsingId(null);
    }
  }

  async function handleDelete(system: SystemSummary) {
    const ok = await confirm({
      title: "Delete system?",
      message: `"${system.name}" and all its tables and records will be permanently removed.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteSystem(system.id);
      await invalidateApiPrefix(SYSTEMS_KEY);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that system.");
    }
  }

  return (
    <div className="h-screen overflow-y-auto scrollbar-thin">
      <div className="mx-auto grid w-full max-w-7xl grid-cols-1 gap-8 px-6 py-8 md:px-10 lg:grid-cols-[22rem_1fr]">
        {/* ── Left rail: hero + sources + describe ── */}
        <div className="lg:sticky lg:top-8 lg:self-start">
          <div className="mb-4 inline-flex size-11 items-center justify-center rounded-2xl bg-gradient-to-br from-accent to-accent2 text-white shadow-md shadow-accent/20">
            <Sparkles className="size-5" />
          </div>
          <h1 className="font-display text-3xl font-semibold italic leading-tight tracking-tight text-ink">
            Custom dashboards, CRM &amp; systems in{" "}
            <span className="grad-word not-italic">minutes.</span>
          </h1>
          <p className="mt-3 text-sm text-muted">
            Describe what you want to track and AgentBase builds a working
            system — typed tables of records with a live dashboard on top.
          </p>

          {/* Source options */}
          <div className="mt-5 grid grid-cols-2 gap-2">
            {SOURCES.map((s) => {
              const busy = s.id === "files" && importing !== null;
              const Icon = busy ? Loader2 : s.icon;
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => handleSourceClick(s)}
                  disabled={busy}
                  className={`group flex items-center gap-2 rounded-xl border p-2.5 text-left transition disabled:cursor-wait ${
                    s.describe
                      ? "border-accent/50 bg-accent/10 hover:border-accent"
                      : "border-line bg-surface2 hover:border-accent/40 hover:bg-surface3/60"
                  }`}
                >
                  <span
                    className={`grid size-8 shrink-0 place-items-center rounded-lg ${
                      s.describe ? "bg-accent text-white" : "bg-surface3 text-muted group-hover:text-ink"
                    }`}
                  >
                    <Icon className={`size-4 ${busy ? "animate-spin" : ""}`} />
                  </span>
                  <span className="text-xs font-medium leading-tight text-ink">
                    {s.label}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Hidden picker for the "From files" source (CSV/TSV ingestion) */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            className="hidden"
            onChange={handleFileSelected}
          />
          {importing && (
            <p className="mt-3 inline-flex items-center gap-2 text-xs text-muted">
              <Loader2 className="size-3.5 animate-spin" />
              Parsing {importing}…
            </p>
          )}

          {/* Describe box */}
          <div className="mt-4 rounded-2xl border border-line bg-surface2 p-3 shadow-sm">
            <Textarea
              ref={describeRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void handleCreate();
                }
              }}
              placeholder="e.g. A CRM to track freelance clients with company, contact, project status, and monthly retainer — plus tiles for total MRR and clients by status."
              rows={4}
              maxLength={4000}
              className="resize-none border-0 bg-transparent px-1 text-sm focus-visible:ring-0"
            />
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-muted">⌘↵ to build</span>
              <Button onClick={handleCreate} disabled={!prompt.trim() || creating}>
                {creating ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Building…
                  </>
                ) : (
                  <>
                    <Sparkles className="size-4" />
                    Create system
                  </>
                )}
              </Button>
            </div>
          </div>

          {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
        </div>

        {/* ── Main area: tabs + grid ── */}
        <div className="min-w-0">
          {/* Tabs */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface2 p-1">
              {(
                [
                  { id: "systems", label: "My Systems", count: systems.length },
                  { id: "templates", label: "All Templates", count: templates.length },
                ] as const
              ).map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition ${
                    effectiveTab === t.id
                      ? "bg-accent text-white shadow-sm"
                      : "text-muted hover:text-ink"
                  }`}
                >
                  {t.label}
                  <span
                    className={`rounded-full px-1.5 text-[10px] ${
                      effectiveTab === t.id ? "bg-white/20" : "bg-surface3 text-muted"
                    }`}
                  >
                    {t.count}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Category chips (templates only) */}
          {effectiveTab === "templates" && (
            <div className="mt-4 flex flex-wrap gap-1.5">
              <Chip active={category === null} onClick={() => setCategory(null)}>
                All
              </Chip>
              {AGENTBASE_CATEGORIES.map((c) => (
                <Chip
                  key={c}
                  active={category === c}
                  onClick={() => setCategory(category === c ? null : c)}
                >
                  {c}
                </Chip>
              ))}
            </div>
          )}

          {/* Grid */}
          <div className="mt-6">
            {effectiveTab === "systems" ? (
              systemsLoading ? (
                <CardGridSkeleton />
              ) : systems.length === 0 ? (
                <EmptySystems onBrowse={() => setTab("templates")} />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                  {systems.map((s) => (
                    <SystemCard
                      key={s.id}
                      system={s}
                      onOpen={() => navigate(`/agentbase/${s.id}`)}
                      onDelete={() => handleDelete(s)}
                    />
                  ))}
                </div>
              )
            ) : templatesLoading ? (
              <CardGridSkeleton />
            ) : filteredTemplates.length === 0 ? (
              <p className="rounded-2xl border border-dashed border-line py-14 text-center text-sm text-muted">
                No templates in this category.
              </p>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {filteredTemplates.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    busy={usingId === t.id}
                    onUse={() => handleUseTemplate(t)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Preview thumbnail: a couple of fake stat tiles + a bar sketch ──────────
function DashboardPreview({ accent }: { accent: string }) {
  return (
    <div className={`relative overflow-hidden rounded-xl bg-gradient-to-br ${accent} p-3`}>
      <div className="grid grid-cols-3 gap-2">
        {[0, 1].map((i) => (
          <div key={i} className="rounded-lg bg-black/20 p-2 backdrop-blur-sm">
            <div className="mb-1 h-1 w-6 rounded-full bg-white/40" />
            <div className="h-3 w-8 rounded bg-white/80" />
          </div>
        ))}
        <div className="rounded-lg bg-black/20 p-2 backdrop-blur-sm">
          <div className="grid size-full grid-cols-3 items-end gap-0.5">
            {[60, 90, 45].map((h, i) => (
              <div
                key={i}
                className="rounded-sm bg-white/70"
                style={{ height: `${h}%` }}
              />
            ))}
          </div>
        </div>
      </div>
      {/* Fake table rows */}
      <div className="mt-2 space-y-1 rounded-lg bg-black/20 p-2 backdrop-blur-sm">
        {[100, 80, 90].map((w, i) => (
          <div key={i} className="flex items-center gap-1.5">
            <div className="h-1.5 w-1.5 rounded-full bg-white/50" />
            <div className="h-1.5 rounded-full bg-white/40" style={{ width: `${w}%` }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function SystemCard({
  system,
  onOpen,
  onDelete,
}: {
  system: SystemSummary;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group relative flex flex-col rounded-2xl border border-line bg-surface2 p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md">
      <DashboardPreview accent={system.accent} />
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete system"
        className="absolute right-6 top-6 grid size-7 place-items-center rounded-lg bg-black/30 text-white/80 opacity-0 backdrop-blur-sm transition hover:bg-rose-600/80 hover:text-white group-hover:opacity-100 focus-visible:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </button>

      <div className="mt-3 flex items-start gap-2">
        <span
          className={`grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br ${system.accent} text-white`}
        >
          <SystemIcon name={system.icon} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="line-clamp-1 font-display text-sm font-semibold text-ink">
            {system.name}
          </h3>
          <p className="line-clamp-2 text-xs leading-relaxed text-muted">
            {system.description || system.category}
          </p>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] text-muted">
          <Table2 className="size-3" />
          {system.record_count} record{system.record_count === 1 ? "" : "s"}
        </span>
        <Button size="sm" variant="secondary" onClick={onOpen}>
          Open
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function TemplateCard({
  template,
  busy,
  onUse,
}: {
  template: Template;
  busy: boolean;
  onUse: () => void;
}) {
  const cols = template.tables[0]?.columns.length ?? 0;
  return (
    <div className="group flex flex-col rounded-2xl border border-line bg-surface2 p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md">
      <DashboardPreview accent={template.accent} />

      <div className="mt-3 flex items-start gap-2">
        <span
          className={`grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br ${template.accent} text-white`}
        >
          <SystemIcon name={template.icon} className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="line-clamp-1 font-display text-sm font-semibold text-ink">
              {template.name}
            </h3>
          </div>
          <span className="text-[11px] text-muted">{template.category}</span>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 flex-1 text-xs leading-relaxed text-muted">
        {template.description}
      </p>

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-[11px] text-muted">
          <LayoutGrid className="size-3" />
          {cols} fields · {template.tiles.length} tiles
        </span>
        <Button size="sm" onClick={onUse} disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Creating…
            </>
          ) : (
            <>
              Use
              <ArrowRight className="size-3.5" />
            </>
          )}
        </Button>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
        active
          ? "border-accent/50 bg-accent/15 text-ink"
          : "border-line bg-surface2 text-muted hover:border-accent/40 hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

function CardGridSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Skeleton key={i} className="h-64 rounded-2xl" />
      ))}
    </div>
  );
}

function EmptySystems({ onBrowse }: { onBrowse: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line py-16 text-center">
      <div className="grid size-11 place-items-center rounded-2xl bg-accent/10">
        <Sparkles className="size-5 text-accent" />
      </div>
      <p className="text-sm font-medium text-ink">No systems yet</p>
      <p className="max-w-xs text-xs text-muted">
        Describe what you want to track on the left, or start from a ready-made
        template.
      </p>
      <Button size="sm" variant="secondary" onClick={onBrowse} className="mt-1">
        Browse templates
        <ArrowRight className="size-3.5" />
      </Button>
    </div>
  );
}
