// A single Skill in the marketplace grid: an output-tinted preview tile, the
// skill name, a clamped description, "from <publisher>", an output tag, and an
// Add & Use button. Own (non-builtin) skills also get a delete affordance.
// Purely presentational: the page owns run/delete via the passed callbacks.

import {
  FileText,
  Presentation,
  Table2,
  Image as ImageIcon,
  MessageSquare,
  Database,
  Trash2,
  ArrowRight,
} from "lucide-react";
import { motion } from "motion/react";
import type { Skill, SkillOutput } from "@/lib/skills";
import { Button } from "@/components/ui/button";

const OUTPUT_META: Record<
  SkillOutput,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  doc: { label: "Doc", icon: FileText },
  slides: { label: "Slides", icon: Presentation },
  sheet: { label: "Sheet", icon: Table2 },
  image: { label: "Image", icon: ImageIcon },
  chat: { label: "Chat", icon: MessageSquare },
  data: { label: "Data", icon: Database },
};

export function SkillCard({
  skill,
  index = 0,
  onUse,
  onDelete,
  busy,
}: {
  skill: Skill;
  index?: number;
  onUse: (skill: Skill) => void;
  onDelete?: (skill: Skill) => void;
  busy?: boolean;
}) {
  const meta = OUTPUT_META[skill.output] ?? OUTPUT_META.chat;
  const Icon = meta.icon;
  const isOwn = skill.is_builtin === 0 && skill.publisher === "You";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index, 8) * 0.03 }}
      className="group relative flex h-full flex-col rounded-2xl border border-line bg-surface2 p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md"
    >
      {/* Preview tile: output-tinted gradient with the format icon. */}
      <div
        className={`relative mb-3 flex h-24 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br ${skill.accent}`}
      >
        <Icon className="size-8 text-white/90 drop-shadow" />
        <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-black/25 px-2 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          <Icon className="size-3" />
          {meta.label}
        </span>
        {isOwn && onDelete && (
          <button
            type="button"
            onClick={() => onDelete(skill)}
            aria-label="Delete skill"
            className="absolute left-2 top-2 grid size-7 place-items-center rounded-lg bg-black/25 text-white/80 opacity-0 backdrop-blur-sm transition hover:bg-rose-600/80 hover:text-white group-hover:opacity-100 focus-visible:opacity-100"
          >
            <Trash2 className="size-3.5" />
          </button>
        )}
      </div>

      {/* Body */}
      <h3 className="line-clamp-1 font-display text-sm font-semibold text-ink">
        {skill.name}
      </h3>
      <p className="mt-1 line-clamp-2 flex-1 text-xs leading-relaxed text-muted">
        {skill.description}
      </p>

      {/* Footer */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="truncate text-[11px] text-muted">
          from <span className="font-medium text-ink/80">{skill.publisher}</span>
        </span>
        <Button
          size="sm"
          onClick={() => onUse(skill)}
          disabled={busy}
          className="shrink-0"
        >
          Add &amp; Use
          <ArrowRight className="size-3.5" />
        </Button>
      </div>
    </motion.div>
  );
}
