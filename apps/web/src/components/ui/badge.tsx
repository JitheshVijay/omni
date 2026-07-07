import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { IndexStatus } from "@/lib/types";

// Hairline, crisp-cornered, uppercase-mono tags: the brand's technical label
// voice. Semantic colour variants are retained for the Drive/Hub index states.
const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase leading-4 tracking-[0.05em] transition-colors",
  {
    variants: {
      variant: {
        default: "border-transparent bg-accent/10 text-accent",
        secondary: "border-line bg-surface3 text-muted",
        outline: "border-line bg-transparent text-muted",
        success:
          "border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
        warning: "border-transparent bg-amber-500/10 text-amber-600 dark:text-amber-400",
        danger: "border-transparent bg-rose-500/10 text-rose-600 dark:text-rose-400",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

// Drive/Hub indexing pipeline status → badge. The three in-flight states get
// a spinner so "the indexer is working" reads at a glance.
const INDEX_STATUS_META: Record<
  IndexStatus,
  { label: string; variant: NonNullable<BadgeProps["variant"]>; busy: boolean }
> = {
  pending: { label: "Queued", variant: "secondary", busy: true },
  extracting: { label: "Extracting", variant: "warning", busy: true },
  embedding: { label: "Embedding", variant: "warning", busy: true },
  ready: { label: "Ready", variant: "success", busy: false },
  failed: { label: "Failed", variant: "danger", busy: false },
  skipped: { label: "Not indexed", variant: "outline", busy: false },
};

export function IndexStatusBadge({
  status,
  title,
}: {
  status: IndexStatus;
  title?: string;
}) {
  const meta = INDEX_STATUS_META[status] ?? INDEX_STATUS_META.pending;
  return (
    <Badge variant={meta.variant} title={title}>
      {meta.busy && <Loader2 className="size-3 animate-spin" />}
      {meta.label}
    </Badge>
  );
}

export { Badge, badgeVariants };
