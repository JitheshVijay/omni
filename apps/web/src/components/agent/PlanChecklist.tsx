// The live plan checklist. The engine replaces the whole plan array on every
// `plan_updated`, so this is a pure render of {id,title,status,note}[]. Status
// drives the leading icon: pending (hollow), in_progress (spinner), done
// (check), failed (x), skipped (dash + strike). It's meant to be pinned at the
// top of the run view — the page decides stickiness.

import { motion } from "motion/react";
import {
  Circle,
  CircleCheck,
  CircleMinus,
  CircleX,
  ListChecks,
  Loader2,
} from "lucide-react";
import type { PlanItem, PlanItemStatus } from "@/lib/agent-types";
import { cn } from "@/lib/utils";

const ICONS: Record<PlanItemStatus, typeof Circle> = {
  pending: Circle,
  in_progress: Loader2,
  done: CircleCheck,
  failed: CircleX,
  skipped: CircleMinus,
};

const ICON_CLASS: Record<PlanItemStatus, string> = {
  pending: "text-muted/50",
  in_progress: "text-accent animate-spin",
  done: "text-emerald-500",
  failed: "text-rose-500",
  skipped: "text-muted/50",
};

export function PlanChecklist({
  plan,
  className,
}: {
  plan: PlanItem[];
  className?: string;
}) {
  if (!plan.length) return null;

  const done = plan.filter((p) => p.status === "done").length;
  const total = plan.length;
  const pct = total > 0 ? Math.round((done / total) * 100) : 0;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-line bg-surface2/90 backdrop-blur",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <ListChecks className="size-4 text-accent" />
        <span className="font-display text-sm font-semibold text-ink">Plan</span>
        <span className="ml-auto text-[11px] tabular-nums text-muted">
          {done}/{total} done
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 w-full bg-line/60">
        <motion.div
          className="h-full rounded-r-full bg-accent"
          initial={false}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 0.4, ease: "easeOut" }}
        />
      </div>

      <ul className="flex flex-col gap-0.5 p-2">
        {plan.map((item) => {
          const Icon = ICONS[item.status] ?? Circle;
          const active = item.status === "in_progress";
          return (
            <li
              key={item.id}
              className={cn(
                "flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors",
                active && "bg-accent/[0.06]",
              )}
            >
              <Icon
                className={cn("mt-0.5 size-4 shrink-0", ICON_CLASS[item.status])}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "text-[13px] leading-snug",
                    item.status === "done" && "text-muted",
                    item.status === "skipped" && "text-muted/70 line-through",
                    item.status === "failed" && "text-rose-600 dark:text-rose-400",
                    active ? "font-medium text-ink" : "text-ink/90",
                  )}
                >
                  {item.title}
                </p>
                {item.note && (
                  <p className="mt-0.5 text-[11px] leading-snug text-muted">{item.note}</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
