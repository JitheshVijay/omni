import { cn } from "@/lib/utils";

// Uppercase mono eyebrow — the brand's technical label voice. Sits above a
// display headline, on a stat tile, or as a section marker. Never carries a
// paragraph. (The `.eyebrow` class lives in globals.css.)
export function Eyebrow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <p className={cn("eyebrow", className)}>{children}</p>;
}
