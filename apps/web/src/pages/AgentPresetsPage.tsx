// /agents: the Custom Agents store, Genspark's "All Agents". A gallery of
// ready-made Super-Agent presets (a goal template + a budget) you launch in
// one click, plus save-your-own. A centered .grad-word hero, Community / My
// Own tabs, category filter chips, a search box, a New Agent create dialog,
// and a responsive grid of preset cards.
//
// Launch handoff: a preset that needs a topic opens a small dialog asking for
// it; otherwise it launches immediately. Launch calls POST
// /api/agent-presets/:id/launch, which starts a REAL agent run, then navigates
// to /agent/<run_id> where the live timeline takes over.

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import {
  Bot,
  Building2,
  CalendarCheck,
  Loader2,
  Newspaper,
  PenLine,
  Plane,
  Plus,
  Recycle,
  Rocket,
  Search,
  ShoppingCart,
  Sparkles,
  Swords,
  Telescope,
  Trash2,
  TrendingUp,
  Users,
  Wallet,
} from "lucide-react";
import { motion } from "motion/react";
import { invalidateApiPrefix, useApi } from "@/lib/use-api";
import {
  createPreset,
  deletePreset,
  launchPreset,
  presetNeedsInput,
  presetsQuery,
  PRESET_CATEGORIES,
  type AgentPreset,
  type PresetCategory,
} from "@/lib/agent-presets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Eyebrow } from "@/components/brand/Eyebrow";

type Tab = "community" | "mine";

// Map the stored lucide icon name string to a component; Bot is the fallback.
const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  Telescope,
  Building2,
  Newspaper,
  Swords,
  Users,
  TrendingUp,
  Recycle,
  PenLine,
  Plane,
  ShoppingCart,
  CalendarCheck,
  Rocket,
  Bot,
};

function iconFor(name: string): ComponentType<{ className?: string }> {
  return ICONS[name] ?? Bot;
}

export default function AgentPresetsPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [tab, setTab] = useState<Tab>("community");
  const [category, setCategory] = useState<PresetCategory | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [launchingId, setLaunchingId] = useState<string | null>(null);
  const [topicPreset, setTopicPreset] = useState<AgentPreset | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const key = useMemo(
    () =>
      presetsQuery({
        tab,
        q: debouncedQ || undefined,
        category: category ?? undefined,
      }),
    [tab, debouncedQ, category],
  );

  const { data, isInitialLoading, isValidating } = useApi<{ presets: AgentPreset[] }>(key, {
    keepPreviousData: true,
  });
  const presets = data?.presets ?? [];

  // Launch a preset: create a real agent run, then hand off to its live view.
  async function runLaunch(preset: AgentPreset, input?: string) {
    if (launchingId) return;
    setLaunchingId(preset.id);
    setError(null);
    try {
      const { run_id } = await launchPreset(preset.id, input);
      void invalidateApiPrefix("/api/agent/runs");
      navigate(`/agent/${run_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not launch that agent.");
      setLaunchingId(null);
    }
  }

  // A preset with a {{input}} topic asks for it first; otherwise launch now.
  function handleUse(preset: AgentPreset) {
    if (launchingId) return;
    if (presetNeedsInput(preset)) {
      setTopicPreset(preset);
    } else {
      void runLaunch(preset);
    }
  }

  async function handleDelete(preset: AgentPreset) {
    const ok = await confirm({
      title: "Delete agent?",
      message: `"${preset.name}" will be removed from your agents.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deletePreset(preset.id);
      await invalidateApiPrefix("/api/agent-presets");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that agent.");
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-6xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      {/* Hero */}
      <div className="pt-4 text-center">
        <div className="mx-auto mb-4 grid size-12 place-items-center rounded-lg bg-ink text-surface">
          <Bot className="size-6" />
        </div>
        <Eyebrow className="text-center">Agents</Eyebrow>
        <h1 className="mx-auto mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          <span className="grad-word">Custom agents</span> for every job.
        </h1>
        <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
          Launch a ready-made Super Agent in one click, or save your own. Each
          preset carries a goal and a budget. Press Use and a real agent run
          plans, acts across tools, and reports back live.
        </p>
      </div>

      {/* Actions row */}
      <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {/* Tabs */}
        <div className="inline-flex items-center gap-1 rounded-xl border border-line bg-surface2 p-1">
          {(
            [
              { id: "community", label: "Community" },
              { id: "mine", label: "My Own" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded px-3 py-1.5 text-sm font-medium transition ${
                tab === t.id
                  ? "bg-accent text-white"
                  : "text-muted hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {/* Search */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search agents…"
              className="w-56 pl-9"
            />
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New Agent
          </Button>
        </div>
      </div>

      {/* Category filter */}
      <div className="mt-4 flex items-start gap-3">
        <span className="mt-1.5 w-16 shrink-0 text-xs font-medium uppercase tracking-wider text-muted">
          Category
        </span>
        <div className="flex flex-wrap gap-1.5">
          <Chip active={category === null} onClick={() => setCategory(null)}>
            All
          </Chip>
          {PRESET_CATEGORIES.map((c) => (
            <Chip
              key={c}
              active={category === c}
              onClick={() => setCategory(category === c ? null : c)}
            >
              {c}
            </Chip>
          ))}
        </div>
      </div>

      {error && <p className="mt-4 text-sm text-muted">{error}</p>}

      {/* Discover grid */}
      <div className="mt-6">
        <div className="mb-3 flex items-center gap-2">
          <Eyebrow>Discover</Eyebrow>
          {!isInitialLoading && (
            <span className="text-xs text-muted/70">
              {presets.length} agent{presets.length === 1 ? "" : "s"}
            </span>
          )}
          {isValidating && !isInitialLoading && (
            <span className="text-xs text-muted/60">updating…</span>
          )}
        </div>

        {isInitialLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-52 rounded-2xl" />
            ))}
          </div>
        ) : presets.length === 0 ? (
          <EmptyState tab={tab} onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {presets.map((p, i) => (
              <PresetCard
                key={p.id}
                preset={p}
                index={i}
                onUse={handleUse}
                onDelete={handleDelete}
                busy={launchingId === p.id}
              />
            ))}
          </div>
        )}
      </div>

      <CreatePresetDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async () => {
          setTab("mine");
          await invalidateApiPrefix("/api/agent-presets");
        }}
        onError={setError}
      />

      <TopicDialog
        preset={topicPreset}
        busy={!!launchingId}
        onOpenChange={(v) => {
          if (!v) setTopicPreset(null);
        }}
        onLaunch={(input) => {
          const p = topicPreset;
          setTopicPreset(null);
          if (p) void runLaunch(p, input);
        }}
      />
    </div>
  );
}

// ── Preset card ────────────────────────────────────────────────────────────
function PresetCard({
  preset,
  index = 0,
  onUse,
  onDelete,
  busy,
}: {
  preset: AgentPreset;
  index?: number;
  onUse: (preset: AgentPreset) => void;
  onDelete?: (preset: AgentPreset) => void;
  busy?: boolean;
}) {
  const Icon = iconFor(preset.icon);
  const isOwn = preset.is_builtin === 0 && preset.publisher === "You";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index, 8) * 0.03 }}
      className="group relative flex h-full flex-col rounded-lg border border-line bg-surface2 p-4 transition hover:border-accent/40"
    >
      {/* Header: icon badge + category */}
      <div className="mb-3 flex items-start justify-between gap-2">
        <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-ink text-surface">
          <Icon className="size-5" />
        </div>
        <div className="flex items-center gap-1.5">
          <span className="rounded-full border border-line bg-surface3/60 px-2 py-0.5 text-[10px] font-medium text-muted">
            {preset.category}
          </span>
          {isOwn && onDelete && (
            <button
              type="button"
              onClick={() => onDelete(preset)}
              aria-label="Delete agent"
              className="grid size-7 place-items-center rounded-lg text-muted/70 opacity-0 transition hover:bg-surface3 hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      <h3 className="line-clamp-1 font-display text-sm font-semibold text-ink">
        {preset.name}
      </h3>
      <p className="mt-1 line-clamp-3 flex-1 text-xs leading-relaxed text-muted">
        {preset.description}
      </p>

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2 truncate text-[11px] text-muted">
          <span>
            from <span className="font-medium text-ink/80">{preset.publisher}</span>
          </span>
          <span className="inline-flex items-center gap-0.5 text-muted/80">
            <Wallet className="size-3" />${preset.budget_usd.toFixed(2)}
          </span>
        </span>
        <Button size="sm" onClick={() => onUse(preset)} disabled={busy} className="shrink-0">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
          Use
        </Button>
      </div>
    </motion.div>
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

function EmptyState({ tab, onCreate }: { tab: Tab; onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line py-14 text-center">
      <div className="grid size-11 place-items-center rounded-lg bg-ink text-surface">
        <Bot className="size-5" />
      </div>
      <p className="text-sm font-medium text-ink">
        {tab === "mine" ? "No agents of your own yet" : "No agents match those filters"}
      </p>
      <p className="max-w-xs text-xs text-muted">
        {tab === "mine"
          ? "Save a goal + budget as a custom agent and it will show up here, ready to launch in one click."
          : "Try clearing the category or your search, or create your own agent."}
      </p>
      {tab === "mine" && (
        <Button size="sm" onClick={onCreate} className="mt-1">
          <Plus className="size-4" />
          New Agent
        </Button>
      )}
    </div>
  );
}

// ── Topic prompt (for presets that take a {{input}}) ─────────────────────────
function TopicDialog({
  preset,
  busy,
  onOpenChange,
  onLaunch,
}: {
  preset: AgentPreset | null;
  busy: boolean;
  onOpenChange: (v: boolean) => void;
  onLaunch: (input: string) => void;
}) {
  const [input, setInput] = useState("");

  // Reset the field each time a new preset opens the dialog.
  useEffect(() => {
    if (preset) setInput("");
  }, [preset]);

  const open = !!preset;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{preset?.name}</DialogTitle>
          <DialogDescription>{preset?.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="block text-xs font-medium text-muted" htmlFor="agent-topic">
            What should this agent work on?
          </label>
          <Textarea
            id="agent-topic"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && input.trim()) {
                e.preventDefault();
                onLaunch(input.trim());
              }
            }}
            placeholder="e.g. the on-device LLM inference market"
            rows={3}
            maxLength={4000}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => input.trim() && onLaunch(input.trim())} disabled={!input.trim() || busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            Launch agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Create flow ──────────────────────────────────────────────────────────
function CreatePresetDialog({
  open,
  onOpenChange,
  onCreated,
  onError,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<PresetCategory>("Research");
  const [template, setTemplate] = useState("");
  const [budget, setBudget] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setName("");
    setDescription("");
    setCategory("Research");
    setTemplate("");
    setBudget("");
  }

  async function submit() {
    if (!name.trim() || !template.trim() || saving) return;
    setSaving(true);
    const budgetNum = Number.parseFloat(budget);
    try {
      await createPreset({
        name: name.trim(),
        description: description.trim() || undefined,
        category,
        goal_template: template.trim(),
        ...(Number.isFinite(budgetNum) && budgetNum > 0 ? { budget_usd: budgetNum } : {}),
      });
      reset();
      onOpenChange(false);
      await onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create that agent.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : onOpenChange(false))}>
      <DialogContent className="max-h-[88vh] overflow-y-auto scrollbar-thin sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New agent</DialogTitle>
          <DialogDescription>
            Save a goal + budget as a one-click agent. Use{" "}
            <code className="rounded bg-surface3 px-1 py-0.5 text-[11px] text-ink">
              {"{{input}}"}
            </code>{" "}
            in the goal where a topic should go, and you'll be asked for it on launch.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly competitor teardown"
              maxLength={120}
              autoFocus
            />
          </Field>

          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line on what this agent does"
              maxLength={500}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Category">
              <Select value={category} onValueChange={(v) => setCategory(v as PresetCategory)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRESET_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Budget (USD)">
              <div className="relative">
                <Wallet className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
                <Input
                  type="number"
                  inputMode="decimal"
                  min="0"
                  step="0.5"
                  value={budget}
                  onChange={(e) => setBudget(e.target.value)}
                  placeholder="1.50"
                  className="pl-8"
                />
              </div>
            </Field>
          </div>

          <Field label="Goal template">
            <Textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={
                "Research {{input}} thoroughly using web search and write a cited report with an executive summary and sources."
              }
              rows={6}
              maxLength={4000}
              className="text-sm"
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || !template.trim() || saving}>
            {saving ? "Saving…" : "Create agent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}
