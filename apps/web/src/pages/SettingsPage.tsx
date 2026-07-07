// /settings: default model, theme, API key status (configured + tail only,
// never full keys), and a storage debug block (data dir, db path, sqlite-vec
// availability, table list).

import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useApi, authFetch, invalidateApi } from "@/lib/use-api";
import type { SettingsData } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useTheme, type Theme } from "@/components/theme";
import { ModelPicker } from "@/components/chat/ModelPicker";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Eyebrow } from "@/components/brand/Eyebrow";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const THEME_OPTIONS: { value: Theme; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

// Human labels for well-known key names; anything else renders as-is.
const KEY_LABELS: Record<string, string> = {
  openrouter: "OpenRouter",
  exa: "Exa search",
  elevenlabs: "ElevenLabs voice",
  llamaparse: "LlamaParse extraction",
};

export default function SettingsPage() {
  const { data, isInitialLoading } = useApi<SettingsData>("/api/settings");
  const { theme, setTheme } = useTheme();
  const [savingModel, setSavingModel] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function patchSettings(patch: Record<string, unknown>) {
    setError(null);
    try {
      await authFetch("/api/settings", {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      void invalidateApi("/api/settings");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : (err as { message?: string })?.message ?? "Could not save settings.",
      );
    }
  }

  async function changeDefaultModel(modelId: string | null) {
    if (!modelId) return;
    setSavingModel(true);
    await patchSettings({ default_model: modelId });
    setSavingModel(false);
  }

  function changeTheme(t: Theme) {
    setTheme(t); // instant, local
    void patchSettings({ theme: t }); // persisted for parity with the DB row
  }

  return (
    <div className="mx-auto flex h-screen max-w-3xl flex-col gap-6 overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      <div className="pl-10 lg:pl-0">
        <h1 className="font-display text-2xl font-semibold tracking-tight text-ink">
          Settings
        </h1>
        <p className="mt-1 text-sm text-muted">
          Local-first: everything here lives in your Omni data folder.
        </p>
        {error && <p className="mt-2 text-sm text-muted">{error}</p>}
      </div>

      {/* Default model */}
      <Card>
        <CardHeader>
          <Eyebrow>Model</Eyebrow>
          <CardTitle className="text-base">Default model</CardTitle>
          <CardDescription>
            New chats start with this model unless a hub overrides it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isInitialLoading ? (
            <Skeleton className="h-9 w-72" />
          ) : (
            <ModelPicker
              value={data?.default_model ?? null}
              onChange={(m) => void changeDefaultModel(m)}
              disabled={savingModel}
              className="max-w-sm"
            />
          )}
        </CardContent>
      </Card>

      {/* Theme */}
      <Card>
        <CardHeader>
          <Eyebrow>Theme</Eyebrow>
          <CardTitle className="text-base">Appearance</CardTitle>
          <CardDescription>Choose a theme, or follow your OS.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            {THEME_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = theme === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => changeTheme(opt.value)}
                  className={cn(
                    "flex flex-1 max-w-[140px] flex-col items-center gap-1.5 rounded-xl border px-4 py-3 text-sm transition",
                    active
                      ? "border-accent bg-accent/[0.07] text-accent"
                      : "border-line bg-surface text-muted hover:border-accent/40 hover:text-ink",
                  )}
                  aria-pressed={active}
                >
                  <Icon className="size-4" />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* API keys */}
      <Card>
        <CardHeader>
          <Eyebrow>Keys</Eyebrow>
          <CardTitle className="text-base">API keys</CardTitle>
          <CardDescription>
            Set in your <code className="font-mono text-xs">.env</code>. Only status
            and the last characters are shown here.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isInitialLoading ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-16 w-full" />
              ))}
            </div>
          ) : Object.keys(data?.keys ?? {}).length === 0 ? (
            <p className="text-sm text-muted">No key status reported.</p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2">
              {Object.entries(data!.keys).map(([name, k]) => (
                <div
                  key={name}
                  className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">
                      {KEY_LABELS[name.toLowerCase()] ?? name}
                    </p>
                    <p className="font-mono text-[11px] text-muted">
                      {k.configured ? `••••${k.keyTail ?? ""}` : "not set"}
                    </p>
                  </div>
                  <Badge variant={k.configured ? "success" : "outline"}>
                    {k.configured ? "Configured" : "Missing"}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Storage debug */}
      <Card className="mb-8">
        <CardHeader>
          <Eyebrow>Data</Eyebrow>
          <CardTitle className="text-base">Storage</CardTitle>
          <CardDescription>Where your data lives on disk.</CardDescription>
        </CardHeader>
        <CardContent>
          {isInitialLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : data?.storage ? (
            <dl className="space-y-2 text-sm">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <dt className="w-24 shrink-0 text-muted">Data dir</dt>
                <dd className="min-w-0 break-all font-mono text-xs text-ink">
                  {data.storage.dataDir}
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <dt className="w-24 shrink-0 text-muted">Database</dt>
                <dd className="min-w-0 break-all font-mono text-xs text-ink">
                  {data.storage.dbPath}
                </dd>
              </div>
              <div className="flex flex-wrap items-center gap-x-3">
                <dt className="w-24 shrink-0 text-muted">Vector index</dt>
                <dd>
                  <Badge variant={data.storage.vec ? "success" : "warning"}>
                    {data.storage.vec ? "sqlite-vec loaded" : "JS fallback"}
                  </Badge>
                </dd>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3">
                <dt className="w-24 shrink-0 text-muted">Tables</dt>
                <dd className="font-mono text-xs text-ink">{data.storage.tables}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-sm text-muted">No storage info reported.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
