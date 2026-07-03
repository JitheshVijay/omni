import { cn } from "@/lib/utils";

// Primitive skeleton block, pulsing on the line token so it reads in both
// themes. Compose inline for page-specific loading shapes.
export function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("animate-pulse rounded-md bg-line/70", className)} {...props} />
  );
}
