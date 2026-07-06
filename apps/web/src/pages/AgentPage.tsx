// /agent — the Super Agent launcher. A big goal box (optional hub grounding +
// budget), "Run agent" creates the run and hands off to /agent/:id where the
// live timeline takes over. Below, the recent runs list links back into any
// prior run.

import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowRight,
  Bot,
  FolderKanban,
  ListChecks,
  Loader2,
  Search,
  Sparkles,
  Store,
  Wallet,
  Wrench,
} from "lucide-react";
import { useApi, invalidateApiPrefix } from "@/lib/use-api";
import { createRun } from "@/lib/agent-stream";
import type { AgentRun } from "@/lib/agent-types";
import type { Hub } from "@/lib/types";
import { cn, formatCost, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RunStatusBadge } from "@/components/agent/RunHeader";

const NO_HUB = "__none__";

const EXAMPLES = [
  "Research the top 3 approaches to on-device LLM inference and write a one-page brief with sources.",
  "Find the latest news on the EU AI Act and summarize what changed this quarter.",
  "Turn the notes in my hub into a 10-slide deck with a cover image.",
];

// Featured preset chips shown on the store strip; deep-link to /agents.
const FEATURED_AGENTS = ["Deep research", "Competitor teardown", "Company dossier"];

const CAPABILITIES = [
  { icon: Search, text: "Searches the web & reads pages" },
  { icon: Wrench, text: "Generates docs, images & slides" },
  { icon: ListChecks, text: "Shows its plan, step by step" },
];

export default function AgentPage() {
  const navigate = useNavigate();
  const { data: hubsData } = useApi<{ hubs: Hub[] }>("/api/hubs");
  const hubs = hubsData?.hubs ?? [];
  const { data, isInitialLoading } = useApi<{ runs: AgentRun[] }>("/api/agent/runs");
  const runs = data?.runs ?? [];

  const [goal, setGoal] = useState("");
  const [hubId, setHubId] = useState<string>(NO_HUB);
  const [budget, setBudget] = useState("");
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function launch() {
    const trimmed = goal.trim();
    if (!trimmed || launching) return;
    setLaunching(true);
    setError(null);
    const budgetNum = Number.parseFloat(budget);
    try {
      const run = await createRun({
        goal: trimmed,
        ...(hubId !== NO_HUB ? { hub_id: hubId } : {}),
        ...(Number.isFinite(budgetNum) && budgetNum > 0 ? { budget_usd: budgetNum } : {}),
      });
      void invalidateApiPrefix("/api/agent/runs");
      navigate(`/agent/${run.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the run.");
      setLaunching(false);
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-4xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      {/* Hero + launcher */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: "easeOut" }}
        className="pl-10 lg:pl-0"
      >
        <div className="flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-accent to-accent2 shadow-lg shadow-accent/25">
            <Bot className="size-6 text-white" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
              Super Agent
            </h1>
            <p className="text-sm text-muted">
              Give it a goal — it plans, acts across tools, and reports back live.
            </p>
          </div>
        </div>

        <div className="mt-5 rounded-2xl border border-line bg-gradient-to-b from-accent/[0.05] to-transparent p-4 md:p-5">
          <Textarea
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void launch();
              }
            }}
            placeholder="What should the agent accomplish? Be specific about the deliverable — e.g. “Research X and produce a 10-slide deck plus a one-page summary doc.”"
            rows={4}
            maxLength={4000}
            autoFocus
            className="resize-none border-0 bg-transparent px-0 text-[15px] shadow-none focus:ring-0"
          />

          <div className="mt-3 flex flex-wrap items-end gap-3 border-t border-line pt-3">
            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
              Ground in a hub{" "}
              <span className="font-normal">(optional)</span>
              <Select value={hubId} onValueChange={setHubId}>
                <SelectTrigger className="h-9 w-52" aria-label="Hub">
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

            <label className="flex flex-col gap-1.5 text-xs font-medium text-muted">
              Budget{" "}
              <span className="font-normal">(optional)</span>
              <div className="relative w-32">
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
                  aria-label="Budget in USD"
                />
              </div>
            </label>

            <Button
              className="ml-auto"
              onClick={() => void launch()}
              disabled={!goal.trim() || launching}
            >
              {launching ? <Loader2 className="animate-spin" /> : <Sparkles />}
              Run agent
            </Button>
          </div>

          {error && (
            <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>
          )}
        </div>

        {/* Example goals + capability strip */}
        {!goal.trim() && (
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => setGoal(ex)}
                className="max-w-full truncate rounded-full border border-line bg-surface2 px-3 py-1.5 text-xs text-muted transition hover:border-accent/40 hover:text-ink"
                title={ex}
              >
                {ex}
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
          {CAPABILITIES.map((c) => (
            <span key={c.text} className="inline-flex items-center gap-1.5 text-[11px] text-muted">
              <c.icon className="size-3.5 text-accent" />
              {c.text}
            </span>
          ))}
        </div>
      </motion.div>

      {/* Browse the Custom Agents store */}
      <Link
        to="/agents"
        className="group mt-6 flex items-center gap-3 rounded-2xl border border-line bg-surface2 p-4 transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md"
      >
        <div className="grid size-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent2 text-white shadow-sm">
          <Store className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink group-hover:text-accent">
            Browse agent presets
          </p>
          <p className="text-xs text-muted">
            Launch a ready-made Super Agent in one click, or save your own.
          </p>
        </div>
        <div className="hidden shrink-0 flex-wrap items-center gap-1.5 sm:flex">
          {FEATURED_AGENTS.map((f) => (
            <span
              key={f}
              className="rounded-full border border-line bg-surface3/60 px-2.5 py-1 text-[11px] text-muted transition group-hover:border-accent/30"
            >
              {f}
            </span>
          ))}
        </div>
        <ArrowRight className="size-4 shrink-0 text-muted/50 transition group-hover:translate-x-0.5 group-hover:text-accent" />
      </Link>

      {/* Recent runs */}
      <div className="mt-9">
        <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wider text-muted">
          Recent runs
        </h2>
        {isInitialLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line py-12 text-center">
            <div className="grid size-11 place-items-center rounded-2xl bg-accent/10">
              <Bot className="size-5 text-accent" />
            </div>
            <p className="text-sm font-medium text-ink">No runs yet</p>
            <p className="max-w-xs text-xs text-muted">
              Describe a goal above and the agent's plan and progress will stream in
              real time.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface2">
            {runs.map((r, i) => (
              <RunRow key={r.id} run={r} index={i} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function RunRow({ run, index }: { run: AgentRun; index: number }) {
  return (
    <motion.li
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, delay: Math.min(index * 0.03, 0.24) }}
    >
      <Link
        to={`/agent/${run.id}`}
        className={cn(
          "group flex items-center gap-3 px-4 py-3 transition hover:bg-ink/[0.02]",
        )}
      >
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent/10 text-accent">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink group-hover:text-accent">
            {run.title || run.goal}
          </p>
          <p className="text-[11px] text-muted">
            {timeAgo(run.created_at)}
            {run.cost_usd > 0 && <> · {formatCost(run.cost_usd)}</>}
          </p>
        </div>
        <RunStatusBadge status={run.status} />
        <ArrowRight className="size-4 shrink-0 text-muted/50 transition group-hover:translate-x-0.5 group-hover:text-accent" />
      </Link>
    </motion.li>
  );
}
