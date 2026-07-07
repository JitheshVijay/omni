// /skills — the Skills library marketplace: "reusable AI tools for specific
// jobs". A centered hero, a New Skill create flow, Community / My Own tabs,
// Role + Output filter chips, a search box, and a responsive Discover grid of
// SkillCards.
//
// Add & Use handoff: every skill resolves its prompt via POST /api/skills/:id/
// run, then hands the resolved prompt off to a BRAND-NEW chat thread — the
// same handoff ChatIndexPage uses (POST /api/chat/threads, then navigate to
// /chat/:id with router state { initialMessage }). ChatThreadPage sends it on
// mount. This is the simplest robust v1: it works identically for every skill
// (chat and generator targets alike), and the chat/agent can then invoke the
// right generator from the seeded instruction. (The resolved run result also
// carries { target, generator } so a future version can deep-link straight
// into a generator hub without changing the backend.)

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Plus, Search, Wand2 } from "lucide-react";
import { authFetch, invalidateApiPrefix, useApi } from "@/lib/use-api";
import type { ChatThread } from "@/lib/types";
import type { ChatNavState } from "@/pages/ChatIndexPage";
import {
  createSkill,
  deleteSkill,
  runSkill,
  skillsQuery,
  SKILL_OUTPUTS,
  SKILL_ROLES,
  type Skill,
  type SkillOutput,
  type SkillRole,
} from "@/lib/skills";
import { SkillCard } from "@/components/skills/SkillCard";
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
import { HeroBand } from "@/components/brand/HeroBand";
import { WordmarkBanner } from "@/components/brand/WordmarkBanner";

type Tab = "community" | "mine";

// Target options offered in the create form: a plain chat handoff, or one of
// the generators. Output tint is derived server-side from `output`.
const TARGET_OPTIONS: { value: string; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "doc", label: "Doc generator" },
  { value: "slides", label: "Slides generator" },
  { value: "sheet", label: "Sheet generator" },
  { value: "image", label: "Image generator" },
];

const OUTPUT_LABEL: Record<SkillOutput, string> = {
  doc: "Docs",
  slides: "Slides",
  sheet: "Sheets",
  image: "Images",
  chat: "Chat",
  data: "Data",
};

export default function SkillsPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();

  const [tab, setTab] = useState<Tab>("community");
  const [role, setRole] = useState<SkillRole | null>(null);
  const [output, setOutput] = useState<SkillOutput | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Debounce the search box so we don't refetch on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(search), 250);
    return () => clearTimeout(t);
  }, [search]);

  const key = useMemo(
    () =>
      skillsQuery({
        tab,
        q: debouncedQ || undefined,
        role: role ?? undefined,
        output: output ?? undefined,
      }),
    [tab, debouncedQ, role, output],
  );

  const { data, isInitialLoading, isValidating } = useApi<{ skills: Skill[] }>(key, {
    keepPreviousData: true,
  });
  const skills = data?.skills ?? [];

  // Start a brand-new chat seeded with the resolved skill prompt (same handoff
  // as ChatIndexPage: create thread, navigate with { initialMessage }).
  async function handleUse(skill: Skill) {
    if (runningId) return;
    setRunningId(skill.id);
    setError(null);
    try {
      const { prompt } = await runSkill(skill.id);
      const thread = await authFetch<ChatThread>("/api/chat/threads", {
        method: "POST",
        body: JSON.stringify({}),
      });
      void invalidateApiPrefix("/api/chat/threads");
      navigate(`/chat/${thread.id}`, {
        state: { initialMessage: prompt } satisfies ChatNavState,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run that skill.");
      setRunningId(null);
    }
  }

  async function handleDelete(skill: Skill) {
    const ok = await confirm({
      title: "Delete skill?",
      message: `"${skill.name}" will be removed from your library.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await deleteSkill(skill.id);
      await invalidateApiPrefix("/api/skills");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that skill.");
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-6xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      {/* Hero */}
      <HeroBand>
        <div className="mx-auto max-w-2xl text-center">
          <Eyebrow>Skills</Eyebrow>
          <h1 className="mx-auto mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            Skills are reusable AI tools for <span className="grad-word">specific jobs</span>.
          </h1>
          <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
            Browse a curated library of saved prompts, add the ones you need, and
            save your own. Every skill drops straight into a new chat, ready to run.
          </p>
        </div>
      </HeroBand>

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
              placeholder="Search skills…"
              className="w-56 pl-9"
            />
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" />
            New Skill
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="mt-4 space-y-2">
        <FilterRow label="Role">
          <Chip active={role === null} onClick={() => setRole(null)}>
            All
          </Chip>
          {SKILL_ROLES.map((r) => (
            <Chip key={r} active={role === r} onClick={() => setRole(role === r ? null : r)}>
              {r}
            </Chip>
          ))}
        </FilterRow>
        <FilterRow label="Output">
          <Chip active={output === null} onClick={() => setOutput(null)}>
            All
          </Chip>
          {SKILL_OUTPUTS.map((o) => (
            <Chip
              key={o}
              active={output === o}
              onClick={() => setOutput(output === o ? null : o)}
            >
              {OUTPUT_LABEL[o]}
            </Chip>
          ))}
        </FilterRow>
      </div>

      {error && <p className="mt-4 text-sm text-muted">{error}</p>}

      {/* Discover grid */}
      <div className="mt-6">
        <div className="mb-3 flex items-center gap-2">
          <Eyebrow>Discover</Eyebrow>
          {!isInitialLoading && (
            <span className="text-xs text-muted/70">
              {skills.length} skill{skills.length === 1 ? "" : "s"}
            </span>
          )}
          {isValidating && !isInitialLoading && (
            <span className="text-xs text-muted/60">updating…</span>
          )}
        </div>

        {isInitialLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-56 rounded-2xl" />
            ))}
          </div>
        ) : skills.length === 0 ? (
          <EmptyState tab={tab} onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {skills.map((s, i) => (
              <SkillCard
                key={s.id}
                skill={s}
                index={i}
                onUse={handleUse}
                onDelete={handleDelete}
                busy={runningId === s.id}
              />
            ))}
          </div>
        )}
      </div>

      <CreateSkillDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={async () => {
          setTab("mine");
          await invalidateApiPrefix("/api/skills");
        }}
        onError={setError}
      />

      <WordmarkBanner />
    </div>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="mt-1.5 w-14 shrink-0 text-xs font-medium uppercase tracking-wider text-muted">
        {label}
      </span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
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

function EmptyState({ tab, onCreate }: { tab: Tab; onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-line py-14 text-center">
      <div className="grid size-11 place-items-center rounded-lg bg-ink text-surface">
        <Wand2 className="size-5" />
      </div>
      <p className="text-sm font-medium text-ink">
        {tab === "mine" ? "No skills of your own yet" : "No skills match those filters"}
      </p>
      <p className="max-w-xs text-xs text-muted">
        {tab === "mine"
          ? "Save a reusable prompt as a skill and it will show up here, ready to run in one click."
          : "Try clearing a filter or your search — or create your own skill."}
      </p>
      {tab === "mine" && (
        <Button size="sm" onClick={onCreate} className="mt-1">
          <Plus className="size-4" />
          New Skill
        </Button>
      )}
    </div>
  );
}

// ── Create flow ──────────────────────────────────────────────────────────
function CreateSkillDialog({
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
  const [role, setRole] = useState<SkillRole>("General");
  const [output, setOutput] = useState<SkillOutput>("chat");
  const [target, setTarget] = useState<string>("chat");
  const [template, setTemplate] = useState("");
  const [saving, setSaving] = useState(false);

  function reset() {
    setName("");
    setDescription("");
    setRole("General");
    setOutput("chat");
    setTarget("chat");
    setTemplate("");
  }

  async function submit() {
    if (!name.trim() || !template.trim() || saving) return;
    setSaving(true);
    try {
      await createSkill({
        name: name.trim(),
        description: description.trim() || undefined,
        role,
        output,
        target,
        prompt_template: template.trim(),
      });
      reset();
      onOpenChange(false);
      await onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create that skill.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => (v ? onOpenChange(true) : onOpenChange(false))}>
      <DialogContent className="max-h-[88vh] overflow-y-auto scrollbar-thin sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New skill</DialogTitle>
          <DialogDescription>
            Save a reusable instruction. Use{" "}
            <code className="rounded bg-surface3 px-1 py-0.5 text-[11px] text-ink">
              {"{{input}}"}
            </code>{" "}
            in the template where the running text should go.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Field label="Name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly competitor brief"
              maxLength={120}
              autoFocus
            />
          </Field>

          <Field label="Description">
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="One line on what this skill does"
              maxLength={500}
            />
          </Field>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Role">
              <Select value={role} onValueChange={(v) => setRole(v as SkillRole)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SKILL_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Output">
              <Select value={output} onValueChange={(v) => setOutput(v as SkillOutput)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SKILL_OUTPUTS.map((o) => (
                    <SelectItem key={o} value={o}>
                      {OUTPUT_LABEL[o]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Target">
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TARGET_OPTIONS.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>

          <Field label="Prompt template">
            <Textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              placeholder={"Write a weekly competitor brief on: {{input}}.\nInclude positioning, pricing, strengths, gaps…"}
              rows={7}
              maxLength={8000}
              className="font-mono text-xs"
            />
          </Field>
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!name.trim() || !template.trim() || saving}>
            {saving ? "Saving…" : "Create skill"}
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
