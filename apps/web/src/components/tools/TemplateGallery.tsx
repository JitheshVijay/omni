// Genspark-style template gallery that leads each generator hub. Category tab
// pills filter a responsive grid of template cards; each card shows a mock
// TemplatePreview and, on click, calls onUse(template) to seed the page's
// generation form (or, for docs, navigate into the editor). Pure frontend:
// no generation happens here.

import { useState } from "react";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import {
  categoriesForKind,
  templatesForKind,
  type GenKind,
  type GenTemplate,
} from "@/lib/templates";
import { TemplatePreview } from "@/components/tools/TemplatePreview";
import { cn } from "@/lib/utils";

export function TemplateGallery({
  kind,
  onUse,
}: {
  kind: GenKind;
  onUse: (template: GenTemplate) => void;
}) {
  const categories = categoriesForKind(kind);
  const [active, setActive] = useState<string>("All");

  const all = templatesForKind(kind);
  const templates = active === "All" ? all : all.filter((t) => t.category === active);

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">
          Start from a template
        </h2>
        {/* Category tab pills */}
        <div className="flex flex-wrap gap-1.5">
          {categories.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setActive(c)}
              aria-pressed={active === c}
              className={cn(
                "rounded-full px-3 py-1 text-xs font-medium transition",
                active === c
                  ? "bg-accent text-white shadow-sm"
                  : "border border-line bg-surface2 text-muted hover:border-accent/40 hover:text-ink",
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-4">
        {templates.map((t, i) => (
          <TemplateCard key={t.id} template={t} index={i} onUse={onUse} />
        ))}
      </div>
    </section>
  );
}

function TemplateCard({
  template,
  index,
  onUse,
}: {
  template: GenTemplate;
  index: number;
  onUse: (t: GenTemplate) => void;
}) {
  return (
    <motion.button
      type="button"
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.24) }}
      onClick={() => onUse(template)}
      className="group flex flex-col overflow-hidden rounded-xl border border-line bg-surface2 p-2.5 text-left shadow-sm outline-none transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-lg focus-visible:ring-2 focus-visible:ring-accent/50"
      aria-label={`Use template: ${template.title}`}
    >
      <div className="relative">
        <TemplatePreview template={template} />
        {/* Use-template affordance on hover */}
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-center gap-1 bg-gradient-to-t from-black/55 to-transparent px-2 py-2 text-[11px] font-semibold text-white opacity-0 transition group-hover:opacity-100">
          Use template
          <ArrowRight className="size-3 transition group-hover:translate-x-0.5" />
        </span>
      </div>
      <div className="mt-2 px-0.5 pb-0.5">
        <p className="truncate text-sm font-medium text-ink group-hover:text-accent">
          {template.title}
        </p>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="rounded-full border border-line bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted">
            {template.category}
          </span>
          <span className="truncate text-[11px] text-muted">{template.description}</span>
        </div>
      </div>
    </motion.button>
  );
}
