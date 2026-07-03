// /agent — Phase 1 placeholder. The Super Agent engine (plan → act →
// observe → backtrack with live SSE progress) lands in Phase 3; the schema
// and read-only routes already exist, so we render the (empty) runs list to
// prove the wiring.

import { motion } from "motion/react";
import { Bot, ListChecks, Search, Wrench } from "lucide-react";
import { useApi } from "@/lib/use-api";
import type { AgentRun } from "@/lib/types";
import { timeAgo, formatCost, cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";

const STATUS_VARIANT: Record<AgentRun["status"], "default" | "secondary" | "success" | "warning" | "danger"> = {
  queued: "secondary",
  planning: "warning",
  running: "warning",
  awaiting_confirmation: "warning",
  paused: "secondary",
  completed: "success",
  failed: "danger",
  cancelled: "secondary",
};

const CAPABILITIES = [
  {
    icon: Search,
    title: "Researches for you",
    text: "Web search, page reading, and your hub memory — stitched into one loop.",
  },
  {
    icon: Wrench,
    title: "Uses real tools",
    text: "Drive reads/writes, image generation, code execution — with confirm cards for anything external.",
  },
  {
    icon: ListChecks,
    title: "Shows its plan",
    text: "A live checklist streams in as the agent plans, acts, and backtracks.",
  },
];

export default function AgentPage() {
  const { data, isInitialLoading } = useApi<{ runs: AgentRun[] }>("/api/agent/runs");
  const runs = data?.runs ?? [];

  return (
    <div className="mx-auto flex h-screen max-w-4xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
        className="flex flex-col items-center gap-4 rounded-2xl border border-line bg-gradient-to-b from-accent/[0.06] to-transparent px-6 py-14 text-center"
      >
        <div className="grid size-16 place-items-center rounded-2xl bg-gradient-to-br from-accent to-accent2 shadow-lg shadow-accent/25">
          <Bot className="size-8 text-white" />
        </div>
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink">
          Super Agent arrives in Phase 3
        </h1>
        <p className="max-w-md text-sm leading-relaxed text-muted">
          An autonomous loop that plans, acts across tools, and streams every step
          live — pausable, resumable, and budget-aware.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {CAPABILITIES.map((c) => (
            <div
              key={c.title}
              className="rounded-xl border border-line bg-surface2 p-4 text-left"
            >
              <c.icon className="mb-2 size-4 text-accent" />
              <p className="text-sm font-medium text-ink">{c.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{c.text}</p>
            </div>
          ))}
        </div>
      </motion.div>

      <div className="mt-8">
        <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wider text-muted">
          Runs
        </h2>
        {isInitialLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : runs.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line py-8 text-center">
            <p className="text-sm text-muted">
              No runs yet — this list fills up once the engine ships.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line bg-surface2">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-3">
                <Bot className="size-4 shrink-0 text-muted" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {r.title || r.goal}
                  </p>
                  <p className="text-[11px] text-muted">
                    {timeAgo(r.created_at)}
                    {r.cost_usd > 0 && <> · {formatCost(r.cost_usd)}</>}
                  </p>
                </div>
                <Badge
                  variant={STATUS_VARIANT[r.status] ?? "secondary"}
                  className={cn("capitalize")}
                >
                  {r.status.replace(/_/g, " ")}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
