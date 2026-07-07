// A pure CSS/SVG MOCK preview of a template's output: kind-aware and static.
// It stands in for Genspark's rendered thumbnails: NO real generation happens
// here. Each kind gets a distinct, tasteful ~16:10 mock:
//   doc    → a mini document (colored title bar + gray text lines)
//   slides → a mini 16:9 slide (gradient header band + title + 3 bullet lines)
//   sheet  → a mini table grid (accent header row + rows/cells)
//   image  → a gradient swatch (template.accent) with a subtle icon

import { FileText, ImageIcon, Presentation, Table2 } from "lucide-react";
import type { GenTemplate } from "@/lib/templates";
import { cn } from "@/lib/utils";

export function TemplatePreview({ template }: { template: GenTemplate }) {
  return (
    <div className="relative aspect-[16/10] w-full overflow-hidden rounded-lg border border-line bg-surface">
      {template.kind === "doc" && <DocPreview accent={template.accent} />}
      {template.kind === "slides" && <SlidesPreview accent={template.accent} />}
      {template.kind === "sheet" && <SheetPreview accent={template.accent} />}
      {template.kind === "image" && <ImagePreview accent={template.accent} />}
    </div>
  );
}

// A subtle paper background shared by the "document-like" mocks.
function DocPreview({ accent }: { accent: string }) {
  return (
    <div className="absolute inset-0 flex flex-col gap-1.5 bg-surface2 p-3">
      <div className={cn("h-2 w-1/2 rounded-full bg-gradient-to-r", accent)} />
      <div className="mt-1 h-1.5 w-full rounded-full bg-ink/10" />
      <div className="h-1.5 w-11/12 rounded-full bg-ink/10" />
      <div className="h-1.5 w-full rounded-full bg-ink/10" />
      <div className="h-1.5 w-4/5 rounded-full bg-ink/10" />
      <div className="mt-1 h-1.5 w-2/3 rounded-full bg-ink/[0.07]" />
      <div className="h-1.5 w-11/12 rounded-full bg-ink/[0.07]" />
      <div className="h-1.5 w-3/4 rounded-full bg-ink/[0.07]" />
    </div>
  );
}

function SlidesPreview({ accent }: { accent: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-surface2 p-2.5">
      <div className="flex aspect-video w-full flex-col overflow-hidden rounded-md border border-line bg-surface shadow-sm">
        <div className={cn("h-1/3 w-full bg-gradient-to-br", accent)} />
        <div className="flex flex-1 flex-col justify-center gap-1.5 p-2.5">
          <div className="h-1.5 w-2/3 rounded-full bg-ink/25" />
          <div className="mt-0.5 flex items-center gap-1.5">
            <span className={cn("size-1 shrink-0 rounded-full bg-gradient-to-r", accent)} />
            <div className="h-1 w-3/4 rounded-full bg-ink/12" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className={cn("size-1 shrink-0 rounded-full bg-gradient-to-r", accent)} />
            <div className="h-1 w-2/3 rounded-full bg-ink/12" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className={cn("size-1 shrink-0 rounded-full bg-gradient-to-r", accent)} />
            <div className="h-1 w-4/5 rounded-full bg-ink/12" />
          </div>
        </div>
      </div>
    </div>
  );
}

function SheetPreview({ accent }: { accent: string }) {
  const cols = 4;
  const rows = 4;
  return (
    <div className="absolute inset-0 bg-surface2 p-3">
      <div className="grid h-full w-full grid-cols-4 grid-rows-5 overflow-hidden rounded-md border border-line bg-line/50 gap-px">
        {/* Header row */}
        {Array.from({ length: cols }).map((_, c) => (
          <div
            key={`h-${c}`}
            className={cn("flex items-center bg-gradient-to-r px-1.5", accent)}
          >
            <span className="h-1 w-3/4 rounded-full bg-white/70" />
          </div>
        ))}
        {/* Body cells */}
        {Array.from({ length: cols * rows }).map((_, i) => (
          <div key={`c-${i}`} className="flex items-center bg-surface px-1.5">
            <span
              className={cn(
                "h-1 rounded-full bg-ink/12",
                i % 4 === 0 ? "w-2/3" : i % 3 === 0 ? "w-1/2" : "w-4/5",
              )}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function ImagePreview({ accent }: { accent: string }) {
  return (
    <div className={cn("absolute inset-0 bg-gradient-to-br", accent)}>
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_25%,rgba(255,255,255,0.28),transparent_55%)]" />
      <div className="absolute inset-0 grid place-items-center">
        <ImageIcon className="size-7 text-white/70 drop-shadow" strokeWidth={1.5} />
      </div>
    </div>
  );
}

/** Small badge icon per kind, reused by the gallery card. */
export function kindIcon(kind: GenTemplate["kind"]) {
  switch (kind) {
    case "doc":
      return FileText;
    case "slides":
      return Presentation;
    case "sheet":
      return Table2;
    case "image":
      return ImageIcon;
  }
}
