import { cn } from "@/lib/utils";

// A pastel-tinted stat tile: a big display number over an uppercase-mono
// label, on one of the brand's non-gradient accent tints. Breaks up the white
// middle bands. Always dark ink on the pastel fill.
const TINTS = {
  mint: "bg-brandMint",
  periwinkle: "bg-brandPeriwinkle",
  magenta: "bg-brandMagenta/15",
  orange: "bg-brandOrange/10",
} as const;

export function StatTile({
  value,
  label,
  tint = "mint",
  className,
}: {
  value: React.ReactNode;
  label: React.ReactNode;
  tint?: keyof typeof TINTS;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg p-6 text-black", TINTS[tint], className)}>
      <div className="font-display text-3xl font-medium tracking-tight sm:text-4xl">
        {value}
      </div>
      <p className="eyebrow mt-2 text-black/55">{label}</p>
    </div>
  );
}
