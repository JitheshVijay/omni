// Paged deck viewer. The current slide is rendered on its native 1280x720
// canvas and scaled to fit the stage via a CSS transform (scale =
// min(stageW/1280, stageH/720)); the SlideRenderer itself never scales.
// Left/right arrows (and Home/End) page through; a thumbnail strip and an
// overview grid jump around; each slide carries a "Revise with AI"
// affordance that hands a slide-scoped prefill up to the editor.
//
// A print portal (rendered into <body>, hidden on screen) lays every slide
// out one-per-page for the browser's Print → Save-as-PDF path; the scoped
// <style> hides the app and reveals it only under @media print.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, LayoutGrid, WandSparkles, X } from "lucide-react";
import { SlideRenderer } from "@/components/tools/SlideRenderer";
import { ARCHETYPE_LABEL, SLIDE_H, SLIDE_W, type DeckContent, type SlideSpec } from "@/lib/slide-types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

function slideLabel(slide: SlideSpec): string {
  const title =
    "title" in slide && slide.title
      ? slide.title
      : slide.archetype === "quote"
        ? slide.quote
        : ARCHETYPE_LABEL[slide.archetype];
  return title;
}

/** A slide painted at a fixed pixel width (used by thumbs + overview). */
function ScaledSlide({
  slide,
  theme,
  width,
}: {
  slide: SlideSpec;
  theme: DeckContent["theme"];
  width: number;
}) {
  const scale = width / SLIDE_W;
  return (
    <div
      style={{ width, height: SLIDE_H * scale, overflow: "hidden" }}
      className="pointer-events-none select-none"
    >
      <div style={{ width: SLIDE_W, height: SLIDE_H, transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <SlideRenderer slide={slide} theme={theme} />
      </div>
    </div>
  );
}

export interface DeckViewerProps {
  deck: DeckContent;
  /** Fired by a slide's "Revise with AI" button with a slide-scoped prefill. */
  onRevise?: (prefill: string) => void;
  className?: string;
}

export function DeckViewer({ deck, onRevise, className }: DeckViewerProps) {
  const slides = deck.slides;
  const [index, setIndex] = useState(0);
  const [overview, setOverview] = useState(false);
  const [scale, setScale] = useState(0.5);
  const stageRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);

  const count = slides.length;
  const clampedIndex = Math.min(index, Math.max(0, count - 1));
  const current = slides[clampedIndex];

  const go = useCallback(
    (target: number) => setIndex(Math.max(0, Math.min(count - 1, target))),
    [count],
  );

  // Fit-to-stage scaling via ResizeObserver on the stage (not the slide, so
  // there's no measurement feedback loop).
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) {
        setScale(Math.min(width / SLIDE_W, height / SLIDE_H));
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keyboard navigation (ignored while typing in a field).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        go(clampedIndex + 1);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        go(clampedIndex - 1);
      } else if (e.key === "Home") {
        go(0);
      } else if (e.key === "End") {
        go(count - 1);
      } else if (e.key === "Escape" && overview) {
        setOverview(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [clampedIndex, count, go, overview]);

  // Keep the active thumbnail in view.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-thumb="${clampedIndex}"]`)
      ?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
  }, [clampedIndex]);

  function reviseCurrent() {
    if (!onRevise || !current) return;
    const label = slideLabel(current);
    onRevise(
      `On slide ${clampedIndex + 1} (${ARCHETYPE_LABEL[current.archetype]}${
        label ? `, “${label.slice(0, 60)}”` : ""
      }): `,
    );
  }

  if (count === 0) {
    return (
      <div className={cn("grid place-items-center text-sm text-muted", className)}>
        This deck has no slides.
      </div>
    );
  }

  return (
    <div className={cn("slides-screen flex min-h-0 flex-col", className)}>
      {/* Stage */}
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-ink/5 p-4 md:p-8">
        <div ref={stageRef} className="flex h-full w-full items-center justify-center">
          <div
            style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}
            className="relative overflow-hidden rounded-xl shadow-2xl ring-1 ring-black/10"
          >
            <div
              style={{
                width: SLIDE_W,
                height: SLIDE_H,
                transform: `scale(${scale})`,
                transformOrigin: "top left",
              }}
            >
              {current && <SlideRenderer slide={current} theme={deck.theme} />}
            </div>
          </div>
        </div>

        {/* Prev / Next */}
        <button
          type="button"
          onClick={() => go(clampedIndex - 1)}
          disabled={clampedIndex === 0}
          aria-label="Previous slide"
          className="absolute left-3 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-surface2/80 text-ink shadow-md ring-1 ring-line backdrop-blur transition hover:bg-surface2 disabled:opacity-0"
        >
          <ChevronLeft className="size-5" />
        </button>
        <button
          type="button"
          onClick={() => go(clampedIndex + 1)}
          disabled={clampedIndex >= count - 1}
          aria-label="Next slide"
          className="absolute right-3 top-1/2 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-surface2/80 text-ink shadow-md ring-1 ring-line backdrop-blur transition hover:bg-surface2 disabled:opacity-0"
        >
          <ChevronRight className="size-5" />
        </button>

        {/* Top-right controls over the stage */}
        <div className="absolute right-4 top-4 flex items-center gap-2">
          {onRevise && (
            <Button size="sm" variant="secondary" onClick={reviseCurrent} className="shadow-md">
              <WandSparkles />
              Revise slide
            </Button>
          )}
          <Button
            size="iconSm"
            variant="secondary"
            onClick={() => setOverview(true)}
            aria-label="Overview grid"
            className="shadow-md"
          >
            <LayoutGrid />
          </Button>
        </div>

        {/* Slide counter */}
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-surface2/80 px-3 py-1 text-xs font-medium text-muted shadow ring-1 ring-line backdrop-blur">
          {clampedIndex + 1} / {count}
        </div>
      </div>

      {/* Thumbnail strip */}
      <div
        ref={stripRef}
        className="flex shrink-0 items-center gap-2.5 overflow-x-auto scrollbar-thin border-t border-line bg-surface px-3 py-3"
      >
        {slides.map((s, i) => (
          <button
            key={i}
            type="button"
            data-thumb={i}
            onClick={() => go(i)}
            aria-label={`Go to slide ${i + 1}`}
            className={cn(
              "group relative shrink-0 overflow-hidden rounded-lg ring-1 transition",
              i === clampedIndex
                ? "ring-2 ring-accent"
                : "ring-line hover:ring-accent/50",
            )}
          >
            <span className="absolute left-1 top-1 z-10 rounded bg-black/45 px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white">
              {i + 1}
            </span>
            <ScaledSlide slide={s} theme={deck.theme} width={148} />
          </button>
        ))}
      </div>

      {/* Overview grid overlay */}
      {overview && (
        <div className="fixed inset-0 z-50 flex flex-col bg-surface/95 backdrop-blur-sm">
          <div className="flex items-center justify-between border-b border-line px-6 py-3">
            <h2 className="font-display text-sm font-semibold text-ink">
              All slides · {count}
            </h2>
            <Button size="iconSm" variant="ghost" onClick={() => setOverview(false)} aria-label="Close overview">
              <X />
            </Button>
          </div>
          <div className="grid flex-1 grid-cols-2 gap-4 overflow-y-auto scrollbar-thin p-6 sm:grid-cols-3 xl:grid-cols-4">
            {slides.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => {
                  go(i);
                  setOverview(false);
                }}
                className={cn(
                  "group relative overflow-hidden rounded-xl ring-1 transition hover:-translate-y-0.5 hover:shadow-lg",
                  i === clampedIndex ? "ring-2 ring-accent" : "ring-line hover:ring-accent/50",
                )}
              >
                <span className="absolute left-2 top-2 z-10 rounded bg-black/45 px-2 py-0.5 text-[11px] font-semibold leading-none text-white">
                  {i + 1}
                </span>
                <ScaledSlide slide={s} theme={deck.theme} width={340} />
              </button>
            ))}
          </div>
        </div>
      )}

      <DeckPrintFrame deck={deck} />
    </div>
  );
}

// ─── Print portal ───────────────────────────────────────────────────
//
// Rendered into <body> (a sibling of #root) so an @media print rule can
// hide #root entirely and reveal only these one-per-page slides. Hidden on
// screen. Page box is set to the slide's exact pixel size so each slide is
// its own full-bleed PDF page.

export function DeckPrintFrame({ deck }: { deck: DeckContent }) {
  const nodes = (
    <>
      <style>{PRINT_CSS}</style>
      <div className="slides-print-portal" aria-hidden>
        {deck.slides.map((s, i) => (
          <div key={i} className="slides-print-page">
            <SlideRenderer slide={s} theme={deck.theme} />
          </div>
        ))}
      </div>
    </>
  );
  if (typeof document === "undefined") return null;
  return createPortal(nodes, document.body);
}

const PRINT_CSS = `
.slides-print-portal { display: none; }
@media print {
  @page { size: ${SLIDE_W}px ${SLIDE_H}px; margin: 0; }
  html, body { height: auto !important; background: #fff !important; }
  body > #root { display: none !important; }
  .slides-print-portal { display: block !important; }
  .slides-print-page {
    width: ${SLIDE_W}px;
    height: ${SLIDE_H}px;
    overflow: hidden;
    page-break-after: always;
    break-after: page;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }
  .slides-print-page:last-child { page-break-after: auto; break-after: auto; }
}
`;
