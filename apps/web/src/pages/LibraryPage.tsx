// /library — every generated artifact in one place, filterable by kind.
// Docs open the editor, images deep-link into Image Studio's detail dialog,
// audio plays inline on its card.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { AudioLines, FileText, Image as ImageIcon, LibraryBig } from "lucide-react";
import { useApi } from "@/lib/use-api";
import type { ArtifactSummary } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { ArtifactCard } from "@/components/tools/ArtifactCard";

type KindFilter = "all" | "doc" | "image" | "audio";

const TABS: { value: KindFilter; label: string; icon?: typeof FileText }[] = [
  { value: "all", label: "All" },
  { value: "doc", label: "Docs", icon: FileText },
  { value: "image", label: "Images", icon: ImageIcon },
  { value: "audio", label: "Audio", icon: AudioLines },
];

const EMPTY_COPY: Record<KindFilter, string> = {
  all: "Everything you generate — docs, images, narrations — collects here.",
  doc: "No documents yet. Draft one in AI Docs and it lands here.",
  image: "No images yet. Paint one in Image Studio and it lands here.",
  audio: "No narrations yet. Hit Listen on a doc and save it, or run the TTS generator.",
};

export default function LibraryPage() {
  const navigate = useNavigate();
  const [kind, setKind] = useState<KindFilter>("all");

  const listPath =
    kind === "all" ? "/api/artifacts?limit=50" : `/api/artifacts?kind=${kind}&limit=50`;
  const { data, isInitialLoading } = useApi<{ artifacts: ArtifactSummary[] }>(listPath);
  const artifacts = data?.artifacts ?? [];

  function openArtifact(a: ArtifactSummary) {
    if (a.kind === "doc") navigate(`/tools/docs/${a.id}`);
    else if (a.kind === "image")
      navigate("/tools/images", { state: { openId: a.id } });
    // audio plays inline on its card — no viewer page.
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-6xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 pl-10 lg:pl-0">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
            Library
          </h1>
          <p className="mt-1 text-sm text-muted">
            Everything the generators have made for you.
          </p>
        </div>

        {/* Kind filter tabs */}
        <div className="flex rounded-lg border border-line bg-surface2 p-0.5 shadow-sm">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => setKind(t.value)}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition",
                  kind === t.value
                    ? "bg-accent text-white shadow-sm"
                    : "text-muted hover:text-ink",
                )}
              >
                {Icon && <Icon className="size-3.5" />}
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {isInitialLoading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : artifacts.length === 0 ? (
        <div className="mt-16 flex flex-col items-center gap-3 text-center">
          <div className="grid size-12 place-items-center rounded-2xl bg-accent/10">
            <LibraryBig className="size-6 text-accent" />
          </div>
          <p className="font-display text-lg font-semibold text-ink">
            {kind === "all" ? "Your library is empty" : "Nothing here yet"}
          </p>
          <p className="max-w-sm text-sm text-muted">{EMPTY_COPY[kind]}</p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {artifacts.map((a) => (
            <ArtifactCard key={a.id} artifact={a} onOpen={openArtifact} />
          ))}
        </div>
      )}
    </div>
  );
}
