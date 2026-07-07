import { cn } from "@/lib/utils";

// The giant terminal wordmark that signs off a long page — set enormous and
// tinted toward the hairline so it reads as a faint stencil, not a heavy title.
// Purely decorative (aria-hidden); scales fluidly with the viewport.
export function WordmarkBanner({
  text = "omni",
  className,
}: {
  text?: string;
  className?: string;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none mt-20 select-none overflow-hidden leading-none",
        className,
      )}
    >
      <div className="wordmark text-[20vw] text-line/70">{text}</div>
    </div>
  );
}
