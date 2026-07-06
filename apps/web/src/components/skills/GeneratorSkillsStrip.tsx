// In-generator Skills (Genspark's "Skills inside generators"). Each generator
// hub renders this strip of community Skills that target its output format;
// clicking "Add & Use" resolves the skill's prompt (POST /api/skills/:id/run)
// and seeds the hub's own generation form via onUse(prompt) — the same seeding
// mechanism the template gallery uses. Hidden entirely when no skills match.

import { useState } from "react";
import { motion } from "motion/react";
import { ArrowRight, Loader2, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { useApi } from "@/lib/use-api";
import { runSkill, skillsQuery, type Skill, type SkillOutput } from "@/lib/skills";
import { cn } from "@/lib/utils";

const LIMIT = 6;

export function GeneratorSkillsStrip({
  output,
  onUse,
}: {
  output: "doc" | "slides" | "sheet" | "image";
  onUse: (prompt: string) => void;
}) {
  const key = skillsQuery({ tab: "community", output: output as SkillOutput });
  const { data } = useApi<{ skills: Skill[] }>(key, { keepPreviousData: true });
  const skills = (data?.skills ?? []).slice(0, LIMIT);

  const [runningId, setRunningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Hide the whole section until at least one skill targets this format.
  if (skills.length === 0) return null;

  async function use(skill: Skill) {
    if (runningId) return;
    setRunningId(skill.id);
    setError(null);
    try {
      const { prompt } = await runSkill(skill.id);
      onUse(prompt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not run that skill.");
    } finally {
      setRunningId(null);
    }
  }

  return (
    <section className="mt-10">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Sparkles className="size-4 text-accent" />
        <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-muted">
          Skills for {output}
        </h2>
        <Link
          to="/skills"
          className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-muted transition hover:text-accent"
        >
          See all in Skills
          <ArrowRight className="size-3" />
        </Link>
      </div>

      {error && <p className="mb-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {skills.map((s, i) => (
          <SkillChip
            key={s.id}
            skill={s}
            index={i}
            busy={runningId === s.id}
            onUse={() => void use(s)}
          />
        ))}
      </div>
    </section>
  );
}

function SkillChip({
  skill,
  index,
  busy,
  onUse,
}: {
  skill: Skill;
  index: number;
  busy: boolean;
  onUse: () => void;
}) {
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.24) }}
      onClick={onUse}
      disabled={busy}
      aria-label={`Use skill: ${skill.name}`}
      className="group flex items-center gap-3 rounded-xl border border-line bg-surface2 p-3 text-left shadow-sm outline-none transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-70"
    >
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br text-white",
          skill.accent,
        )}
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Sparkles className="size-4" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink group-hover:text-accent">
          {skill.name}
        </span>
        <span className="block truncate text-[11px] text-muted">
          {skill.description || `from ${skill.publisher}`}
        </span>
      </span>
      <ArrowRight className="size-4 shrink-0 text-muted/50 transition group-hover:translate-x-0.5 group-hover:text-accent" />
    </motion.button>
  );
}
