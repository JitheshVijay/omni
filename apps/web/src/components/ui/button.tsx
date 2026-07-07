import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Together-inspired Button. Primary CTAs are a crisp (4px) pill with an
// UPPERCASE MONO label and no shadow: `bg-ink text-surface` auto-inverts by
// theme — black-on-white in light, near-white-on-navy in dark. `mint` is the
// hero secondary; `ghost` stays sentence-case for icon rows / low-emphasis.
// (text-transform is visual only — accessible names / DOM text are unchanged.)
const CTA = "font-mono uppercase tracking-[0.03em]";
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: `${CTA} bg-ink text-surface hover:bg-ink/90 active:bg-ink/80`,
        secondary: `${CTA} border border-line bg-surface text-ink hover:bg-surface3 active:bg-surface3`,
        outline: `${CTA} border border-line bg-transparent text-ink hover:bg-surface2`,
        mint: `${CTA} bg-brandMint text-black hover:bg-brandMint/90 active:bg-brandMint/80`,
        ghost: "text-muted hover:bg-ink/5 hover:text-ink",
        destructive: `${CTA} bg-rose-600 text-white hover:bg-rose-600/90`,
      },
      size: {
        default: "h-9 px-4 text-[13px] [&_svg]:size-4",
        sm: "h-8 px-3 text-[12px] [&_svg]:size-3.5",
        lg: "h-10 px-6 text-[13px] [&_svg]:size-4",
        icon: "size-9 [&_svg]:size-4",
        iconSm: "size-8 [&_svg]:size-4",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
