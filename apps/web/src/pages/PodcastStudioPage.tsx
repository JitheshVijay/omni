// /tools/podcast: Podcast Studio. Left: the generation form (topic OR a
// source doc, episode length, host voices); right: the episode being
// generated (live script bubbles narrated by the generator's status labels)
// above the list of past episodes. Each episode card expands into a
// script-synced player: one <audio> for the stitched MP3, a per-turn script
// beside it where clicking a turn seeks to its start_sec and the active
// turn highlights as playback crosses turn boundaries.

import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Download,
  FileText,
  HardDriveUpload,
  Loader2,
  Minus,
  Plus,
  Podcast,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useApi, authFetch, authFetchRaw, invalidateApi, invalidateApiPrefix } from "@/lib/use-api";
import { parseApiError } from "@/lib/api-error";
import { streamGenerate } from "@/lib/generate";
import { useVoiceCatalog } from "@/lib/audio-player";
import { artifactBlobUrl } from "@/components/tools/ArtifactCard";
import type { Artifact, ArtifactSummary, Voice } from "@/lib/types";
import { cn, timeAgo } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Eyebrow } from "@/components/brand/Eyebrow";

const LIST_PATH = "/api/artifacts?kind=audio&limit=100";
const DOCS_PATH = "/api/artifacts?kind=doc&limit=100";

// Mirror of the backend defaults (generators/podcast.ts): Alexandra hosts,
// Daniel explains. Only used for the select placeholders.
const DEFAULT_VOICE_A_NAME = "Alexandra";
const DEFAULT_VOICE_B_NAME = "Daniel";

// ── Script shapes (mirrors artifacts.content for meta.subtype='podcast') ──

interface ScriptTurn {
  speaker: "A" | "B";
  text: string;
}

interface SeekTurn extends ScriptTurn {
  start_sec: number;
}

interface PodcastContent {
  turns: SeekTurn[];
  voice_a: string;
  voice_b: string;
  duration_sec_estimate: number;
}

interface LiveScript {
  title: string;
  turns: ScriptTurn[];
}

function isPodcast(a: ArtifactSummary): boolean {
  return a.meta?.subtype === "podcast";
}

function formatSec(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// The generator emits the script delta as a JSON string (slides-style);
// tolerate an already-parsed object too.
function parseScriptDelta(data: unknown): LiveScript | null {
  try {
    const raw = typeof data === "string" ? (JSON.parse(data) as unknown) : data;
    const obj = raw as { title?: unknown; turns?: unknown };
    if (!Array.isArray(obj?.turns)) return null;
    const turns = (obj.turns as Array<{ speaker?: unknown; text?: unknown }>)
      .filter((t) => typeof t?.text === "string" && (t.text as string).trim())
      .map((t) => ({
        speaker: t.speaker === "B" ? ("B" as const) : ("A" as const),
        text: (t.text as string).trim(),
      }));
    if (turns.length === 0) return null;
    return { title: typeof obj.title === "string" ? obj.title : "New episode", turns };
  } catch {
    return null;
  }
}

interface PodcastStudioNavState {
  openId?: string;
}

export default function PodcastStudioPage() {
  const location = useLocation();
  const navigate = useNavigate();

  const { data, isInitialLoading } = useApi<{ artifacts: ArtifactSummary[] }>(LIST_PATH);
  const episodes = (data?.artifacts ?? []).filter(isPodcast);

  const { data: docsData } = useApi<{ artifacts: ArtifactSummary[] }>(DOCS_PATH);
  const docs = docsData?.artifacts ?? [];

  const { configured, voices } = useVoiceCatalog();

  // ── Generation form ────────────────────────────────────────────────────
  const [prompt, setPrompt] = useState("");
  const [sourceDocId, setSourceDocId] = useState<string>("none");
  const [minutes, setMinutes] = useState(3);
  const [voiceA, setVoiceA] = useState<string>("");
  const [voiceB, setVoiceB] = useState<string>("");
  const [generating, setGenerating] = useState(false);
  const [statusLabel, setStatusLabel] = useState<string | null>(null);
  const [liveScript, setLiveScript] = useState<LiveScript | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Deep-link from Tools/Library: expand a specific episode once the list is
  // in. Router state is cleared immediately so back/refresh doesn't re-open.
  const [pendingOpenId, setPendingOpenId] = useState<string | null>(null);
  useEffect(() => {
    const openId = (location.state as PodcastStudioNavState | null)?.openId;
    if (!openId) return;
    navigate(location.pathname, { replace: true, state: null });
    setPendingOpenId(openId);
  }, [location.state]);
  useEffect(() => {
    if (!pendingOpenId || episodes.length === 0) return;
    if (episodes.some((a) => a.id === pendingOpenId)) {
      setExpandedId(pendingOpenId);
      setPendingOpenId(null);
    }
  }, [pendingOpenId, episodes]);

  // Abort a live generation when leaving the page.
  useEffect(() => () => abortRef.current?.abort(), []);

  const hasSource = Boolean(prompt.trim() || sourceDocId !== "none");
  const canGenerate = hasSource && configured === true && !generating;

  async function generate() {
    if (!canGenerate) return;
    setGenerating(true);
    setGenError(null);
    setLiveScript(null);
    setStatusLabel("Starting…");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const body: Record<string, unknown> = { minutes };
    if (sourceDocId !== "none") body.artifact_id = sourceDocId;
    if (prompt.trim()) body.prompt = prompt.trim();
    if (voiceA) body.voice_a = voiceA;
    if (voiceB) body.voice_b = voiceB;
    try {
      await streamGenerate({
        name: "podcast",
        body,
        signal: ctrl.signal,
        onEvent: (e) => {
          if (e.type === "status") setStatusLabel(e.label);
          else if (e.type === "delta" && e.channel === "script") {
            const script = parseScriptDelta(e.data);
            if (script) setLiveScript(script);
          } else if (e.type === "artifact") {
            void invalidateApi(LIST_PATH);
            void invalidateApiPrefix("/api/artifacts");
            setExpandedId(e.artifact.id);
          } else if (e.type === "error") {
            setGenError(e.message);
          }
        },
      });
    } catch (err) {
      if (!ctrl.signal.aborted) {
        setGenError(err instanceof Error ? err.message : "Generation failed.");
      }
    } finally {
      setGenerating(false);
      setStatusLabel(null);
      setLiveScript(null);
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-6xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <div className="mb-6 flex items-center gap-3 pl-10 lg:pl-0">
        <Button variant="ghost" size="iconSm" asChild aria-label="Back to Tools">
          <Link to="/tools">
            <ArrowLeft />
          </Link>
        </Button>
        <div>
          <Eyebrow>PODCAST</Eyebrow>
          <h1 className="mt-1.5 font-display text-2xl font-semibold tracking-tight text-ink">
            Podcast Studio
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Two hosts, one topic: a curious host and an expert talk it through.
          </p>
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[340px_1fr]">
        {/* Generation form */}
        <div className="rounded-2xl border border-line bg-surface2 p-4 lg:sticky lg:top-0">
          <label className="flex flex-col gap-1.5 text-sm font-medium text-ink">
            Topic
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void generate();
                }
              }}
              placeholder="Why octopuses might be the smartest invertebrates…"
              rows={3}
              maxLength={4000}
              disabled={generating}
            />
          </label>

          <label className="mt-3 flex flex-col gap-1.5 text-sm font-medium text-ink">
            Or start from a document
            <Select
              value={sourceDocId}
              onValueChange={setSourceDocId}
              disabled={generating || docs.length === 0}
            >
              <SelectTrigger aria-label="Source document">
                <SelectValue placeholder="None" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">
                  <span className="text-muted">None (use the topic)</span>
                </SelectItem>
                {docs.map((d) => (
                  <SelectItem key={d.id} value={d.id}>
                    <FileText className="size-3.5 text-muted" />
                    {d.title || "Untitled doc"}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sourceDocId !== "none" && (
              <span className="text-xs font-normal text-muted">
                The topic above (if any) becomes the episode's angle.
              </span>
            )}
          </label>

          <div className="mt-3 flex flex-col gap-1.5 text-sm font-medium text-ink">
            Episode length
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="iconSm"
                aria-label="Shorter"
                onClick={() => setMinutes((m) => Math.max(1, m - 1))}
                disabled={generating || minutes <= 1}
              >
                <Minus />
              </Button>
              <span className="w-16 text-center text-sm tabular-nums text-ink">
                {minutes} min
              </span>
              <Button
                variant="secondary"
                size="iconSm"
                aria-label="Longer"
                onClick={() => setMinutes((m) => Math.min(10, m + 1))}
                disabled={generating || minutes >= 10}
              >
                <Plus />
              </Button>
            </div>
          </div>

          <VoiceSelect
            label="Host A · curious"
            value={voiceA}
            onChange={setVoiceA}
            voices={voices}
            placeholder={`${DEFAULT_VOICE_A_NAME} (default)`}
            disabled={generating || voices.length === 0}
          />
          <VoiceSelect
            label="Host B · expert"
            value={voiceB}
            onChange={setVoiceB}
            voices={voices}
            placeholder={`${DEFAULT_VOICE_B_NAME} (default)`}
            disabled={generating || voices.length === 0}
          />

          {configured === false && (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
              Add ELEVENLABS_API_KEY to enable podcast narration.
            </div>
          )}
          {genError && (
            <p className="mt-3 text-sm text-rose-600 dark:text-rose-400">{genError}</p>
          )}

          <Button className="mt-4 w-full" onClick={() => void generate()} disabled={!canGenerate}>
            {generating ? (
              <>
                <Loader2 className="animate-spin" />
                {statusLabel ?? "Generating…"}
              </>
            ) : (
              <>
                <Sparkles />
                Generate episode
              </>
            )}
          </Button>
        </div>

        {/* Episodes */}
        <div className="flex flex-col gap-3">
          {generating && (
            <LiveEpisodeCard script={liveScript} statusLabel={statusLabel} />
          )}

          {isInitialLoading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-20 rounded-2xl" />
              ))}
            </div>
          ) : episodes.length === 0 && !generating ? (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line py-16 text-center">
              <div className="grid size-12 place-items-center rounded-lg bg-ink text-surface">
                <Podcast className="size-6" />
              </div>
              <p className="font-display text-lg font-semibold text-ink">No episodes yet</p>
              <p className="max-w-xs text-sm text-muted">
                Give the hosts a topic (or a document) on the left and your first
                episode appears here.
              </p>
            </div>
          ) : (
            episodes.map((a, i) => (
              <EpisodeCard
                key={a.id}
                artifact={a}
                index={i}
                expanded={expandedId === a.id}
                onToggle={() => setExpandedId(expandedId === a.id ? null : a.id)}
                onDeleted={() => setExpandedId(null)}
                voices={voices}
              />
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// ── Form: voice select ───────────────────────────────────────────────────

function VoiceSelect({
  label,
  value,
  onChange,
  voices,
  placeholder,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  voices: Voice[];
  placeholder: string;
  disabled: boolean;
}) {
  return (
    <label className="mt-3 flex flex-col gap-1.5 text-sm font-medium text-ink">
      {label}
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger aria-label={label}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {voices.map((v) => (
            <SelectItem key={v.id} value={v.id}>
              {v.name}
              {v.description ? <span className="ml-1.5 text-muted">{v.description}</span> : null}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </label>
  );
}

// ── Speaker bubble (shared by the live view and the player) ──────────────

function SpeakerBubble({
  turn,
  active,
  startSec,
  onClick,
  refCb,
}: {
  turn: ScriptTurn;
  active?: boolean;
  startSec?: number;
  onClick?: () => void;
  refCb?: (el: HTMLDivElement | null) => void;
}) {
  const isA = turn.speaker === "A";
  const body = (
    <>
      <span
        className={cn(
          "flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide",
          isA ? "text-accent" : "text-accent2",
        )}
      >
        Host {turn.speaker}
        {startSec !== undefined && (
          <span className="font-normal normal-case tabular-nums text-muted">
            {formatSec(startSec)}
          </span>
        )}
      </span>
      <p className="mt-1 text-sm leading-relaxed text-ink">{turn.text}</p>
    </>
  );
  const className = cn(
    "max-w-[92%] rounded-xl border px-3 py-2 text-left transition",
    isA
      ? "self-start border-accent/20 bg-accent/5"
      : "self-end border-accent2/20 bg-accent2/5",
    active && (isA ? "border-accent/60 bg-accent/10" : "border-accent2/60 bg-accent2/10"),
    onClick && "cursor-pointer hover:border-accent/50",
  );
  if (onClick) {
    return (
      <div ref={refCb} className={cn("flex flex-col", isA ? "items-start" : "items-end")}>
        <button type="button" onClick={onClick} className={cn(className, "w-fit")}>
          {body}
        </button>
      </div>
    );
  }
  return (
    <div ref={refCb} className={cn("flex flex-col", isA ? "items-start" : "items-end")}>
      <div className={cn(className, "w-fit")}>{body}</div>
    </div>
  );
}

// ── Live generation card ─────────────────────────────────────────────────

function LiveEpisodeCard({
  script,
  statusLabel,
}: {
  script: LiveScript | null;
  statusLabel: string | null;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="overflow-hidden rounded-2xl border border-accent/30 bg-surface2"
    >
      <div className="flex items-center gap-2.5 border-b border-line px-4 py-3">
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink text-surface">
          <Loader2 className="size-4 animate-spin" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">
            {script?.title ?? "New episode"}
          </p>
          <p className="truncate text-xs text-muted">{statusLabel ?? "Generating…"}</p>
        </div>
      </div>
      {script ? (
        <div className="flex max-h-80 flex-col gap-2 overflow-y-auto scrollbar-thin p-4">
          {script.turns.map((t, i) => (
            <SpeakerBubble key={i} turn={t} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-12 w-3/4 rounded-xl" />
          <Skeleton className="ml-auto h-12 w-3/4 rounded-xl" />
          <Skeleton className="h-12 w-2/3 rounded-xl" />
        </div>
      )}
    </motion.div>
  );
}

// ── Episode card + script-synced player ──────────────────────────────────

function EpisodeCard({
  artifact,
  index,
  expanded,
  onToggle,
  onDeleted,
  voices,
}: {
  artifact: ArtifactSummary;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  onDeleted: () => void;
  voices: Voice[];
}) {
  const minutes = typeof artifact.meta?.minutes === "number" ? artifact.meta.minutes : null;
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, delay: Math.min(index * 0.03, 0.25) }}
      className={cn(
        "overflow-hidden rounded-2xl border bg-surface2 transition",
        expanded ? "border-accent/40" : "border-line hover:border-accent/30",
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${artifact.title || "episode"}`}
      >
        <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-ink text-surface">
          <Podcast className="size-4" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-ink">
            {artifact.title || "Untitled episode"}
          </p>
          <p className="text-xs text-muted">
            {minutes !== null && `~${minutes} min · `}
            {timeAgo(artifact.created_at)}
          </p>
        </div>
        <ChevronDown
          className={cn("size-4 shrink-0 text-muted transition-transform", expanded && "rotate-180")}
        />
      </button>
      {expanded && <EpisodePlayer artifact={artifact} onDeleted={onDeleted} voices={voices} />}
    </motion.div>
  );
}

function EpisodePlayer({
  artifact,
  onDeleted,
  voices,
}: {
  artifact: ArtifactSummary;
  onDeleted: () => void;
  voices: Voice[];
}) {
  const confirm = useConfirm();
  const { data, isInitialLoading } = useApi<Artifact>(`/api/artifacts/${artifact.id}`);
  const content = (data?.content ?? null) as PodcastContent | null;
  const turns = Array.isArray(content?.turns) ? content.turns : [];

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const [activeIdx, setActiveIdx] = useState(-1);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [exported, setExported] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Highlight the turn whose start_sec boundary playback last crossed.
  function onTimeUpdate() {
    const audio = audioRef.current;
    if (!audio || turns.length === 0) return;
    const t = audio.currentTime + 0.05;
    let idx = -1;
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].start_sec <= t) idx = i;
      else break;
    }
    setActiveIdx(idx);
  }

  // Keep the active turn in view as playback advances.
  useEffect(() => {
    if (activeIdx < 0) return;
    rowRefs.current[activeIdx]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [activeIdx]);

  function seekTo(i: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = turns[i].start_sec;
    setActiveIdx(i);
    void audio.play();
  }

  const voiceName = (id: string | undefined) =>
    (id && voices.find((v) => v.id === id)?.name) || null;
  const hostA = voiceName(content?.voice_a);
  const hostB = voiceName(content?.voice_b);

  async function download() {
    setBusyAction("download");
    setError(null);
    try {
      const res = await authFetchRaw(`/api/artifacts/${artifact.id}/blob`);
      if (!res.ok) throw new Error((await parseApiError(res)).message);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(artifact.title || "episode").slice(0, 60).replace(/[^\w\s-]/g, "").trim() || "episode"}.mp3`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusyAction(null);
    }
  }

  async function exportToDrive() {
    setBusyAction("export");
    setError(null);
    try {
      await authFetch(`/api/artifacts/${artifact.id}/export-to-drive`, { method: "POST" });
      void invalidateApiPrefix("/api/drive/files");
      setExported(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBusyAction(null);
    }
  }

  async function remove() {
    const ok = await confirm({
      title: "Delete episode?",
      message: <>“{artifact.title}” will be permanently removed. This can't be undone.</>,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setBusyAction("delete");
    try {
      await authFetch(`/api/artifacts/${artifact.id}`, { method: "DELETE" });
      void invalidateApi(LIST_PATH);
      void invalidateApiPrefix("/api/artifacts");
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="border-t border-line">
      <div className="p-4">
        <audio
          ref={audioRef}
          controls
          preload="metadata"
          src={artifactBlobUrl(artifact.id)}
          onTimeUpdate={onTimeUpdate}
          className="h-10 w-full"
        />
        {(hostA || hostB) && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted">
            {hostA && (
              <span className="rounded-full border border-line bg-surface px-2 py-0.5">
                <span className="font-medium text-accent">Host A</span> · {hostA}
              </span>
            )}
            {hostB && (
              <span className="rounded-full border border-line bg-surface px-2 py-0.5">
                <span className="font-medium text-accent2">Host B</span> · {hostB}
              </span>
            )}
            {typeof content?.duration_sec_estimate === "number" && (
              <span className="rounded-full border border-line bg-surface px-2 py-0.5 tabular-nums">
                {formatSec(content.duration_sec_estimate)}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Script with per-turn seek */}
      {isInitialLoading ? (
        <div className="flex flex-col gap-2 px-4 pb-4">
          <Skeleton className="h-12 w-3/4 rounded-xl" />
          <Skeleton className="ml-auto h-12 w-3/4 rounded-xl" />
        </div>
      ) : turns.length > 0 ? (
        <div className="flex max-h-96 flex-col gap-2 overflow-y-auto scrollbar-thin px-4 pb-4">
          {turns.map((t, i) => (
            <SpeakerBubble
              key={i}
              turn={t}
              startSec={t.start_sec}
              active={i === activeIdx}
              onClick={() => seekTo(i)}
              refCb={(el) => {
                rowRefs.current[i] = el;
              }}
            />
          ))}
        </div>
      ) : (
        <p className="px-4 pb-4 text-xs text-muted">No script stored for this episode.</p>
      )}

      {error && (
        <p className="px-4 pb-3 text-sm text-rose-600 dark:text-rose-400">{error}</p>
      )}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void download()}
          disabled={busyAction !== null}
        >
          {busyAction === "download" ? <Loader2 className="animate-spin" /> : <Download />}
          Download
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void exportToDrive()}
          disabled={busyAction !== null || exported}
        >
          {busyAction === "export" ? (
            <Loader2 className="animate-spin" />
          ) : exported ? (
            <Check className="text-emerald-500" />
          ) : (
            <HardDriveUpload />
          )}
          {exported ? "In Drive" : "Export to Drive"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-rose-600 hover:text-rose-600 dark:text-rose-400"
          onClick={() => void remove()}
          disabled={busyAction !== null}
        >
          {busyAction === "delete" ? <Loader2 className="animate-spin" /> : <Trash2 />}
          Delete
        </Button>
      </div>
    </div>
  );
}
