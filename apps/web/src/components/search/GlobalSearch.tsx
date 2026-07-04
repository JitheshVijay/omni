// Global command-palette search: Cmd/Ctrl+K (or the SearchTrigger button)
// opens a modal that queries GET /api/search across Drive, artifacts, chat
// threads, and hub memory. Results are grouped by kind, keyboard-navigable
// (up/down/enter), and each navigates to its href. When embeddings are down
// the API returns mode:'keyword' and we surface a small notice + a Reindex
// affordance.
//
// Integration: mount <GlobalSearch /> ONCE (in AppShell). Place <SearchTrigger />
// anywhere in a header — it dispatches a window event the mounted GlobalSearch
// listens for, so the two don't need to share React state.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FileText,
  HardDrive,
  Loader2,
  MessageSquare,
  Library,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { authFetch } from "@/lib/use-api";
import { cn } from "@/lib/utils";

const OPEN_EVENT = "omni:open-search";

type SearchKind = "drive" | "artifact" | "thread" | "hub_chunk";

interface SearchHit {
  kind: SearchKind;
  ref_id: string;
  title: string;
  snippet: string;
  score: number;
  href: string;
}

interface SearchData {
  results: SearchHit[];
  mode: "semantic" | "keyword";
}

const KIND_META: Record<
  SearchKind,
  { label: string; icon: typeof FileText }
> = {
  drive: { label: "Drive", icon: HardDrive },
  artifact: { label: "Artifacts", icon: Sparkles },
  thread: { label: "Chats", icon: MessageSquare },
  hub_chunk: { label: "Hub memory", icon: Library },
};

const KIND_ORDER: SearchKind[] = ["drive", "artifact", "thread", "hub_chunk"];

/** Header/toolbar button that opens the global search modal. */
export function SearchTrigger({ className }: { className?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-lg border border-line bg-surface2 px-3 text-sm text-muted shadow-sm transition-colors hover:bg-line/40 hover:text-ink",
        className,
      )}
      aria-label="Search everything"
    >
      <Search className="size-4" />
      <span className="hidden sm:inline">Search…</span>
      <kbd className="ml-1 hidden rounded border border-line bg-surface px-1.5 font-sans text-[11px] text-muted sm:inline">
        ⌘K
      </kbd>
    </button>
  );
}

/** Mount once. Owns the modal + the Cmd/Ctrl+K and open-event listeners. */
export function GlobalSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [data, setData] = useState<SearchData | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const [reindexing, setReindexing] = useState(false);
  const [nonce, setNonce] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const reqSeq = useRef(0);

  // ── Open triggers: Cmd/Ctrl+K + the SearchTrigger event ──
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  // Reset transient state each time the modal opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setData(null);
      setActive(0);
      // Radix moves focus on mount; nudge focus to the input next tick.
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  // ── Debounced search ──
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setData(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++reqSeq.current;
    const t = setTimeout(async () => {
      try {
        const res = await authFetch<SearchData>(
          `/api/search?q=${encodeURIComponent(q)}&k=30`,
        );
        if (seq === reqSeq.current) {
          setData(res);
          setActive(0);
        }
      } catch {
        if (seq === reqSeq.current) setData({ results: [], mode: "semantic" });
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, nonce]);

  const results = data?.results ?? [];

  // Grouped for rendering; flat order (grouped) for keyboard nav.
  const grouped = useMemo(() => {
    const map = new Map<SearchKind, SearchHit[]>();
    for (const k of KIND_ORDER) {
      const items = results.filter((r) => r.kind === k);
      if (items.length) map.set(k, items);
    }
    return map;
  }, [results]);

  const flat = useMemo(() => {
    const out: SearchHit[] = [];
    for (const items of grouped.values()) out.push(...items);
    return out;
  }, [grouped]);

  const go = useCallback(
    (hit: SearchHit | undefined) => {
      if (!hit) return;
      setOpen(false);
      navigate(hit.href);
    },
    [navigate],
  );

  const onInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, Math.max(flat.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(flat[active]);
    }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      await authFetch("/api/search/reindex", { method: "POST" });
    } catch {
      /* fire-and-forget on the server; ignore client errors */
    }
    // The sweep runs server-side; give it a beat, then re-run the query.
    setTimeout(() => {
      setReindexing(false);
      setNonce((n) => n + 1);
    }, 1500);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        hideClose
        className="top-[12%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0"
        aria-describedby={undefined}
      >
        {/* Input row */}
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="size-4 shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKeyDown}
            placeholder="Search Drive, artifacts, chats, hub memory…"
            className="h-12 w-full bg-transparent text-sm text-ink outline-none placeholder:text-muted"
          />
          {loading && <Loader2 className="size-4 shrink-0 animate-spin text-muted" />}
        </div>

        {/* Results */}
        <div className="max-h-[min(60vh,26rem)] overflow-y-auto">
          {query.trim() === "" ? (
            <EmptyHint />
          ) : flat.length === 0 && !loading ? (
            <NoResults onReindex={reindex} reindexing={reindexing} />
          ) : (
            <div className="py-1">
              {[...grouped.entries()].map(([kind, items]) => {
                const Meta = KIND_META[kind];
                const Icon = Meta.icon;
                return (
                  <div key={kind} className="py-1">
                    <div className="flex items-center gap-1.5 px-4 py-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                      <Icon className="size-3" />
                      {Meta.label}
                    </div>
                    {items.map((hit) => {
                      const idx = flat.indexOf(hit);
                      const isActive = idx === active;
                      return (
                        <button
                          key={`${hit.kind}:${hit.ref_id}`}
                          type="button"
                          onMouseEnter={() => setActive(idx)}
                          onClick={() => go(hit)}
                          className={cn(
                            "flex w-full flex-col items-start gap-0.5 px-4 py-2 text-left transition-colors",
                            isActive ? "bg-accent/10" : "hover:bg-ink/5",
                          )}
                        >
                          <span className="line-clamp-1 text-sm font-medium text-ink">
                            {hit.title || "Untitled"}
                          </span>
                          {hit.snippet && (
                            <span className="line-clamp-1 text-xs text-muted">
                              {hit.snippet}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer: mode + reindex */}
        <div className="flex items-center justify-between border-t border-line px-4 py-2 text-[11px] text-muted">
          <span>
            {data?.mode === "keyword" ? (
              <span className="text-amber-500">
                Keyword mode — embeddings unavailable
              </span>
            ) : (
              <span className="hidden sm:inline">
                <kbd className="rounded border border-line px-1">↑↓</kbd> navigate{" "}
                <kbd className="ml-1 rounded border border-line px-1">↵</kbd> open
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={reindex}
            disabled={reindexing}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:text-ink disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3", reindexing && "animate-spin")} />
            {reindexing ? "Reindexing…" : "Reindex"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EmptyHint() {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-12 text-center text-sm text-muted">
      <FileText className="size-6 opacity-40" />
      <p>Search across your Drive files, artifacts, chats, and hub memory.</p>
    </div>
  );
}

function NoResults({
  onReindex,
  reindexing,
}: {
  onReindex: () => void;
  reindexing: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-12 text-center text-sm text-muted">
      <p>No matches found.</p>
      <button
        type="button"
        onClick={onReindex}
        disabled={reindexing}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface2 px-3 py-1.5 text-xs text-ink transition-colors hover:bg-line/40 disabled:opacity-50"
      >
        <RefreshCw className={cn("size-3.5", reindexing && "animate-spin")} />
        {reindexing ? "Reindexing…" : "Rebuild search index"}
      </button>
    </div>
  );
}
