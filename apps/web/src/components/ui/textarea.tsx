import * as React from "react";
import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "flex min-h-[72px] w-full rounded border border-line bg-surface px-3 py-2 text-sm text-ink transition-colors",
        "placeholder:text-muted",
        "focus:outline-none focus:ring-2 focus:ring-accent/30 focus:border-accent/50",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "scrollbar-thin",
        className,
      )}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
