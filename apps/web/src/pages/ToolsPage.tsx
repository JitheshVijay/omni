// /tools — the generator suite hub. Hero grid of tool cards (Image Studio,
// AI Docs, Read Aloud explainer, Phase-3 teaser) plus a "Recent creations"
// strip of the latest artifacts across all kinds.

import { Link, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  AudioLines,
  FileText,
  Images,
  Podcast,
  Presentation,
  Sparkles,
  Table2,
  Wrench,
} from "lucide-react";
import { useApi } from "@/lib/use-api";
import { useVoiceCatalog, VOICE_UNCONFIGURED_HINT } from "@/lib/audio-player";
import type { ArtifactSummary } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArtifactCard } from "@/components/tools/ArtifactCard";

export default function ToolsPage() {
  const navigate = useNavigate();
  const { configured } = useVoiceCatalog();
  const { data, isInitialLoading } = useApi<{ artifacts: ArtifactSummary[] }>(
    "/api/artifacts?limit=12",
  );
  const artifacts = data?.artifacts ?? [];

  function openArtifact(a: ArtifactSummary) {
    if (a.kind === "doc") navigate(`/tools/docs/${a.id}`);
    else if (a.kind === "image")
      navigate("/tools/images", { state: { openId: a.id } });
    else if (a.kind === "slides") navigate(`/tools/slides/${a.id}`);
    else if (a.kind === "sheet") navigate(`/tools/sheets/${a.id}`);
    else if (a.kind === "audio" && a.meta?.subtype === "podcast")
      navigate("/tools/podcast", { state: { openId: a.id } });
    // plain TTS audio plays inline on its card — no viewer page.
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-5xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <div className="mb-8 pt-4 text-center">
        <h1 className="font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
          What would you like to <span className="grad-word">make</span>?
        </h1>
        <p className="mx-auto mt-3 max-w-md text-sm text-muted">
          Generators that turn a prompt into something you can keep — everything
          lands in your Library.
        </p>
      </div>

      {/* Hero grid */}
      <div className="grid gap-4 sm:grid-cols-2">
        <ToolCard
          to="/tools/images"
          icon={Images}
          gradient="from-fuchsia-500 to-accent2"
          title="Image Studio"
          text="Generate images from a prompt, then refine them with follow-up edits — full lineage kept."
          index={0}
        />
        <ToolCard
          to="/tools/docs"
          icon={FileText}
          gradient="from-accent to-accent2"
          title="AI Docs"
          text="Draft full documents that stream into a rich editor — grounded in your hub memory with citations."
          index={1}
        />
        <ExplainerCard
          icon={AudioLines}
          title="Read Aloud"
          text="Every doc and chat reply has a Listen button — narrated with ElevenLabs voices, chunk by chunk."
          badge={
            configured === false ? (
              <Badge variant="warning" title={VOICE_UNCONFIGURED_HINT}>
                needs API key
              </Badge>
            ) : configured ? (
              <Badge variant="success">ready</Badge>
            ) : null
          }
          index={2}
        />
        <ToolCard
          to="/tools/slides"
          icon={Presentation}
          gradient="from-sky-500 to-accent"
          title="AI Slides"
          text="Outline-first slide decks across seven layouts — export a real .pptx with editable charts."
          index={3}
        />
        <ToolCard
          to="/tools/sheets"
          icon={Table2}
          gradient="from-emerald-500 to-teal-400"
          title="AI Sheets"
          text="Spreadsheets that stream in row by row — edit any cell, export CSV or .xlsx."
          index={4}
        />
        <ToolCard
          to="/tools/podcast"
          icon={Podcast}
          gradient="from-orange-500 to-amber-400"
          title="Podcast"
          text="Two hosts discuss any topic or document — narrated with contrasting voices, script-synced playback."
          index={5}
        />
        <ExplainerCard
          icon={Sparkles}
          title="Workflows"
          text="Chain the agent, generators, and search into scheduled automations — find them in the sidebar."
          badge={<Badge variant="success">new</Badge>}
          index={6}
        />
      </div>

      {/* Recent creations */}
      <div className="mt-10">
        <h2 className="mb-3 font-display text-sm font-semibold uppercase tracking-wider text-muted">
          Recent creations
        </h2>
        {isInitialLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-40 rounded-xl" />
            ))}
          </div>
        ) : artifacts.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-10 text-center">
            <div className="grid size-11 place-items-center rounded-2xl bg-accent/10">
              <Wrench className="size-5 text-accent" />
            </div>
            <p className="text-sm font-medium text-ink">Nothing generated yet</p>
            <p className="max-w-xs text-xs text-muted">
              Start with an image or a document — everything you create shows up
              here and in your Library.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {artifacts.map((a) => (
              <ArtifactCard key={a.id} artifact={a} onOpen={openArtifact} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ToolCard({
  to,
  icon: Icon,
  gradient,
  title,
  text,
  index,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  gradient: string;
  title: string;
  text: string;
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: index * 0.05 }}
    >
      <Link
        to={to}
        className="group flex h-full flex-col rounded-2xl border border-line bg-surface2 p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-accent/40 hover:shadow-md"
      >
        <div
          className={`mb-3 grid size-11 place-items-center rounded-xl bg-gradient-to-br ${gradient} text-white shadow-md shadow-accent/20 transition group-hover:scale-105`}
        >
          <Icon className="size-5" />
        </div>
        <h2 className="font-display text-base font-semibold text-ink group-hover:text-accent">
          {title}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">{text}</p>
      </Link>
    </motion.div>
  );
}

function ExplainerCard({
  icon: Icon,
  title,
  text,
  badge,
  dashed,
  index,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  text: string;
  badge?: React.ReactNode;
  dashed?: boolean;
  index: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: index * 0.05 }}
      className={`flex h-full flex-col rounded-2xl border p-5 ${
        dashed ? "border-dashed border-line" : "border-line bg-surface2 shadow-sm"
      }`}
    >
      <div className="mb-3 flex items-center justify-between">
        <div className="grid size-11 place-items-center rounded-xl bg-accent/10 text-accent">
          <Icon className="size-5" />
        </div>
        {badge}
      </div>
      <h2 className="font-display text-base font-semibold text-ink">{title}</h2>
      <p className="mt-1 text-sm leading-relaxed text-muted">{text}</p>
    </motion.div>
  );
}
