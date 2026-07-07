import { cn } from "@/lib/utils";

// A near-black (#010120) hero band — the brand's dark surface that opens a
// landing page, with the three-stop gradient as a soft atmospheric ribbon in
// the corner (the only decorative depth in the system). `.band-dark` flips all
// token-based children to their dark values, so cards/muted text/hairlines
// nested inside read correctly regardless of the active theme.
export function HeroBand({
  children,
  className,
  ribbon = true,
}: {
  children: React.ReactNode;
  className?: string;
  ribbon?: boolean;
}) {
  return (
    <section
      className={cn(
        "band-dark relative isolate overflow-hidden rounded-2xl px-6 py-14 sm:px-10 sm:py-16",
        className,
      )}
    >
      {ribbon && (
        <>
          <div
            aria-hidden
            className="brand-ribbon pointer-events-none absolute -right-16 -top-20 -z-10 size-72 rounded-full opacity-60 blur-3xl"
          />
          <div
            aria-hidden
            className="brand-ribbon pointer-events-none absolute -bottom-24 left-1/3 -z-10 size-56 rounded-full opacity-25 blur-3xl"
          />
        </>
      )}
      {children}
    </section>
  );
}
