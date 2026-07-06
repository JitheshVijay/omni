// /agentbase/:id — a single system's dashboard. A header (name + category +
// delete), a row of computed DASHBOARD TILES (stat / bar / donut), then each
// TABLE rendered as an editable data grid (add / delete rows). Records mutate
// through the agentbase client, then the whole system is revalidated so the
// server recomputes the tiles. Loading is StrictMode-safe (SWR-keyed on the id).

import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Trash2, Loader2, Sparkles } from "lucide-react";
import { useApi, invalidateApi } from "@/lib/use-api";
import { deleteSystem, systemKey, type System } from "@/lib/agentbase";
import { SystemIcon } from "@/components/agentbase/SystemIcon";
import { TileCard } from "@/components/agentbase/TileCard";
import { SystemTable } from "@/components/agentbase/SystemTable";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";

export default function SystemViewPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const key = id ? systemKey(id) : null;
  const { data: system, isInitialLoading, error: loadError } = useApi<System>(key);

  async function refetch() {
    if (key) await invalidateApi(key);
  }

  async function handleDelete() {
    if (!system || deleting) return;
    const ok = await confirm({
      title: "Delete system?",
      message: `"${system.name}" and all its tables and records will be permanently removed.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await deleteSystem(system.id);
      navigate("/agentbase");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete that system.");
      setDeleting(false);
    }
  }

  return (
    <div className="h-screen overflow-y-auto scrollbar-thin">
      <div className="mx-auto w-full max-w-6xl px-6 py-8 md:px-10">
        {/* Back link */}
        <Link
          to="/agentbase"
          className="inline-flex items-center gap-1.5 text-sm text-muted transition hover:text-ink"
        >
          <ArrowLeft className="size-4" />
          All systems
        </Link>

        {isInitialLoading ? (
          <LoadingState />
        ) : loadError || !system ? (
          <NotFound />
        ) : (
          <>
            {/* Header */}
            <div className="mt-4 flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-start gap-3">
                <span
                  className={`grid size-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ${system.accent} text-white shadow-md`}
                >
                  <SystemIcon name={system.icon} className="size-6" />
                </span>
                <div>
                  <div className="flex items-center gap-2">
                    <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
                      {system.name}
                    </h1>
                    <span className="rounded-full border border-line bg-surface2 px-2 py-0.5 text-[11px] font-medium text-muted">
                      {system.category}
                    </span>
                  </div>
                  {system.description && (
                    <p className="mt-1 max-w-2xl text-sm text-muted">
                      {system.description}
                    </p>
                  )}
                </div>
              </div>
              <Button
                variant="secondary"
                onClick={handleDelete}
                disabled={deleting}
                className="text-rose-400 hover:text-rose-300"
              >
                {deleting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                Delete
              </Button>
            </div>

            {error && <p className="mt-4 text-sm text-rose-400">{error}</p>}

            {/* Dashboard tiles */}
            {system.tiles.length > 0 && (
              <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {system.tiles.map((tile) => (
                  <TileCard key={tile.id} tile={tile} />
                ))}
              </div>
            )}

            {/* Tables */}
            <div className="mt-8 space-y-6">
              {system.tables.map((table) => (
                <SystemTable
                  key={table.id}
                  systemId={system.id}
                  table={table}
                  onChanged={refetch}
                  onError={setError}
                />
              ))}
            </div>

            <div className="h-12" />
          </>
        )}
      </div>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="mt-4">
      <div className="flex items-center gap-3">
        <Skeleton className="size-12 rounded-2xl" />
        <div className="space-y-2">
          <Skeleton className="h-6 w-56" />
          <Skeleton className="h-4 w-80" />
        </div>
      </div>
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-2xl" />
        ))}
      </div>
      <Skeleton className="mt-8 h-64 rounded-2xl" />
    </div>
  );
}

function NotFound() {
  return (
    <div className="mt-16 flex flex-col items-center gap-3 rounded-2xl border border-dashed border-line py-16 text-center">
      <div className="grid size-11 place-items-center rounded-2xl bg-accent/10">
        <Sparkles className="size-5 text-accent" />
      </div>
      <p className="text-sm font-medium text-ink">System not found</p>
      <p className="max-w-xs text-xs text-muted">
        It may have been deleted. Head back to build or open another one.
      </p>
      <Link to="/agentbase">
        <Button size="sm" variant="secondary" className="mt-1">
          <ArrowLeft className="size-3.5" />
          All systems
        </Button>
      </Link>
    </div>
  );
}
