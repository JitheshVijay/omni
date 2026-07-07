// /connectors: the app-connector store (Genspark-style). Browse a catalog of
// Composio-managed apps (Slack, Notion, GitHub, Linear, Google Drive/Sheets/
// Docs, Airtable, HubSpot, X, Asana, Trello, Discord, Jira, …), connect them via
// hosted OAuth (open the redirect, poll until active), and disconnect. Every
// connected app's actions become agent tools automatically (reads run instantly;
// writes are staged behind a confirmation card in the agent).
//
// Fails soft without COMPOSIO_API_KEY: GET /api/connectors returns
// configured:false and we show a setup banner; Connect buttons are disabled.
// A best-effort "MCP servers" section is shown only if GET /api/mcp/servers
// exists (guarded, hidden on any error).

import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Check,
  KeyRound,
  Loader2,
  PlugZap,
  Search,
  Server,
  Unplug,
} from "lucide-react";
import { useApi, invalidateApi } from "@/lib/use-api";
import {
  connectConnector,
  disconnectConnector,
  listMcpServers,
  refreshConnector,
  CONNECTOR_CATEGORIES,
  CONNECTORS_PATH,
  type Connector,
  type ConnectorCategory,
  type ConnectorStatus,
  type ConnectorsResponse,
  type McpServerInfo,
} from "@/lib/connectors";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Eyebrow } from "@/components/brand/Eyebrow";
import { HeroBand } from "@/components/brand/HeroBand";
import { WordmarkBanner } from "@/components/brand/WordmarkBanner";
import { cn } from "@/lib/utils";
import { ConnectorGlyph } from "@/lib/connector-icons";

function statusBadge(status: ConnectorStatus) {
  switch (status) {
    case "active":
      return { label: "Connected", variant: "success" as const };
    case "pending":
      return { label: "Authorizing…", variant: "warning" as const };
    case "error":
      return { label: "Needs attention", variant: "danger" as const };
    default:
      return null;
  }
}

export default function ConnectorsPage() {
  const confirm = useConfirm();
  const { data, isInitialLoading } = useApi<ConnectorsResponse>(CONNECTORS_PATH);

  const configured = data?.configured ?? false;
  const connectors = useMemo(() => data?.connectors ?? [], [data]);

  const [category, setCategory] = useState<ConnectorCategory | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // `${action}:${toolkit}`
  const [error, setError] = useState<string | null>(null);

  // Stop any in-flight poll loop when we unmount.
  const pollAbort = useRef<{ cancelled: boolean } | null>(null);
  useEffect(
    () => () => {
      if (pollAbort.current) pollAbort.current.cancelled = true;
    },
    [],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return connectors.filter((c) => {
      if (category && c.category !== category) return false;
      if (q && !`${c.name} ${c.description}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [connectors, category, search]);

  const connectedCount = useMemo(
    () => connectors.filter((c) => c.status === "active").length,
    [connectors],
  );

  async function handleConnect(c: Connector) {
    setError(null);
    setBusy(`connect:${c.toolkit}`);
    try {
      const { redirectUrl } = await connectConnector(c.toolkit);
      window.open(redirectUrl, "_blank", "noopener,noreferrer");
      // Poll for activation while the user authorizes in the popup/tab.
      const token = { cancelled: false };
      pollAbort.current = token;
      for (let i = 0; i < 40 && !token.cancelled; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if (token.cancelled) return;
        try {
          const { status } = await refreshConnector(c.toolkit);
          if (status === "active") {
            await invalidateApi(CONNECTORS_PATH);
            return;
          }
        } catch {
          /* transient, keep polling */
        }
      }
      await invalidateApi(CONNECTORS_PATH);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the connection.");
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect(c: Connector) {
    const ok = await confirm({
      title: `Disconnect ${c.name}?`,
      message: <>Omni's agent will lose access to your {c.name}. You can reconnect anytime.</>,
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    setBusy(`disconnect:${c.toolkit}`);
    try {
      await disconnectConnector(c.toolkit);
      await invalidateApi(CONNECTORS_PATH);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-6xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      {/* Hero */}
      <HeroBand>
        <div className="mx-auto max-w-2xl text-center">
          <Eyebrow>Connectors</Eyebrow>
          <h1 className="mx-auto mt-3 max-w-2xl font-display text-3xl font-semibold tracking-tight text-ink sm:text-4xl">
            <span className="grad-word">Connect your apps</span> and put them to work.
          </h1>
          <p className="mx-auto mt-3 max-w-lg text-sm text-muted">
            Link the tools you already use. Every connected app's actions become agent
            tools automatically. Reads run instantly, and anything that sends or changes
            something waits for your confirmation.
          </p>
        </div>
      </HeroBand>

      {/* Not-configured banner */}
      {!isInitialLoading && !configured && (
        <div className="mt-7 flex items-start gap-3 rounded-lg border border-line bg-surface2 p-4">
          <KeyRound className="mt-0.5 size-5 shrink-0 text-muted" />
          <div className="text-sm">
            <p className="font-medium text-ink">Connectors aren't configured yet</p>
            <p className="mt-0.5 text-muted">
              Add a{" "}
              <code className="rounded bg-surface px-1 py-0.5 text-xs">COMPOSIO_API_KEY</code>{" "}
              to your environment and restart the API to connect apps. The catalog below is
              a preview until then.
            </p>
          </div>
        </div>
      )}

      {/* Controls */}
      <div className="mt-7 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Eyebrow>App store</Eyebrow>
          {!isInitialLoading && configured && (
            <span className="text-xs text-muted/70">
              {connectedCount} connected
            </span>
          )}
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search apps…"
            className="w-full pl-9 sm:w-64"
          />
        </div>
      </div>

      {/* Category filter chips */}
      <div className="mt-4 flex flex-wrap gap-1.5">
        <Chip active={category === null} onClick={() => setCategory(null)}>
          All
        </Chip>
        {CONNECTOR_CATEGORIES.map((cat) => (
          <Chip
            key={cat}
            active={category === cat}
            onClick={() => setCategory(category === cat ? null : cat)}
          >
            {cat}
          </Chip>
        ))}
      </div>

      {error && (
        <div className="mt-4 rounded-lg border border-line bg-surface2 px-4 py-3 text-sm text-ink">
          {error}
        </div>
      )}

      {/* Grid */}
      <div className="mt-6">
        {isInitialLoading ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-2xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line py-14 text-center">
            <p className="text-sm font-medium text-ink">No apps match those filters</p>
            <p className="max-w-xs text-xs text-muted">
              Try clearing the category or your search.
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((c, i) => (
              <ConnectorCard
                key={c.toolkit}
                connector={c}
                index={i}
                configured={configured}
                connecting={busy === `connect:${c.toolkit}`}
                disconnecting={busy === `disconnect:${c.toolkit}`}
                onConnect={() => void handleConnect(c)}
                onDisconnect={() => void handleDisconnect(c)}
              />
            ))}
          </div>
        )}
      </div>

      {/* MCP servers (best-effort) */}
      <McpSection />

      <div className="h-6 shrink-0" />
      <WordmarkBanner />
    </div>
  );
}

function ConnectorCard({
  connector,
  index,
  configured,
  connecting,
  disconnecting,
  onConnect,
  onDisconnect,
}: {
  connector: Connector;
  index: number;
  configured: boolean;
  connecting: boolean;
  disconnecting: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const connected = connector.status === "active";
  const badge = statusBadge(connector.status);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, delay: Math.min(index * 0.03, 0.24) }}
      className="flex flex-col rounded-lg border border-line bg-surface2 p-5 transition hover:border-accent/40"
    >
      <div className="flex items-start justify-between">
        <div className="grid size-11 place-items-center rounded-lg border border-line bg-white">
          <ConnectorGlyph toolkit={connector.toolkit} name={connector.name} />
        </div>
        {configured && badge && (
          <Badge variant={badge.variant}>
            {connector.status === "pending" && <Loader2 className="size-3 animate-spin" />}
            {connector.status === "active" && <Check className="size-3" />}
            {badge.label}
          </Badge>
        )}
      </div>

      <h3 className="mt-3 font-display text-base font-semibold text-ink">{connector.name}</h3>
      <p className="mt-1 flex-1 text-sm text-muted">{connector.description}</p>

      <div className="mt-4 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
          {connector.category}
        </span>
        {connected ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted"
            onClick={onDisconnect}
            disabled={disconnecting}
          >
            {disconnecting ? <Loader2 className="animate-spin" /> : <Unplug />}
            Disconnect
          </Button>
        ) : (
          <Button size="sm" onClick={onConnect} disabled={!configured || connecting}>
            {connecting ? <Loader2 className="animate-spin" /> : <PlugZap />}
            {connecting ? "Waiting…" : "Connect"}
          </Button>
        )}
      </div>
    </motion.div>
  );
}

// Read-only display of configured MCP servers. The endpoint may not exist yet,
// we fetch once, guard every failure, and simply render nothing on error/empty.
function McpSection() {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMcpServers()
      .then((res) => {
        if (!cancelled) setServers(Array.isArray(res?.servers) ? res.servers : []);
      })
      .catch(() => {
        if (!cancelled) setServers(null); // hide the section on any error
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!servers || servers.length === 0) return null;

  return (
    <div className="mt-10">
      <div className="mb-3 flex items-center gap-2">
        <Server className="size-4 text-muted" />
        <Eyebrow>MCP servers</Eyebrow>
        <span className="text-xs text-muted/70">
          {servers.length} configured
        </span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {servers.map((s) => (
          <div
            key={s.name}
            className="flex items-center justify-between rounded-xl border border-line bg-surface2 px-4 py-3"
          >
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-ink">{s.name}</p>
              {typeof s.toolCount === "number" && (
                <p className="text-xs text-muted">
                  {s.toolCount} tool{s.toolCount === 1 ? "" : "s"}
                </p>
              )}
            </div>
            {s.status && (
              <Badge variant={s.status === "connected" ? "success" : "outline"}>
                {s.status}
              </Badge>
            )}
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-muted">
        MCP servers are configured from a file and shown here for reference.
      </p>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-full border px-3 py-1 text-xs font-medium transition",
        active
          ? "border-accent/50 bg-accent/15 text-ink"
          : "border-line bg-surface2 text-muted hover:border-accent/40 hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
