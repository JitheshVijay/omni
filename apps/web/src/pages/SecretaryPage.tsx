// /secretary: the "Today" hub for the AI Secretary. Connect Gmail + Google
// Calendar via Composio managed OAuth (hosted redirect + poll for activation),
// then generate a "Today" briefing that runs as a normal Super Agent run
// (navigates to /agent/:run_id). Reads run immediately; writes (send / create /
// delete) are always staged behind confirmation cards in the agent, surfaced
// here as an explainer so the user knows nothing is sent without approval.
//
// Fails soft without COMPOSIO_API_KEY: /status returns configured:false and we
// show a setup banner instead of live connection state.

import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import {
  CalendarClock,
  Inbox,
  KeyRound,
  Loader2,
  Mail,
  PlugZap,
  Send,
  Sparkles,
  Unplug,
  Eye,
  ShieldCheck,
} from "lucide-react";
import { useApi, invalidateApi } from "@/lib/use-api";
import {
  connectToolkit,
  disconnectToolkit,
  generateBrief,
  refreshToolkit,
  type ConnectionStatus,
  type SecretaryStatus,
  type SecretaryToolkit,
} from "@/lib/secretary";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Eyebrow } from "@/components/brand/Eyebrow";

const STATUS_PATH = "/api/secretary/status";

interface ToolkitMeta {
  key: SecretaryToolkit;
  name: string;
  blurb: string;
  icon: typeof Mail;
}

const TOOLKITS: ToolkitMeta[] = [
  {
    key: "gmail",
    name: "Gmail",
    blurb: "Read and search your inbox; draft, reply, and send behind confirmation.",
    icon: Mail,
  },
  {
    key: "googlecalendar",
    name: "Google Calendar",
    blurb: "See your schedule and create or update events behind confirmation.",
    icon: CalendarClock,
  },
];

function statusBadge(status: ConnectionStatus) {
  switch (status) {
    case "active":
      return { label: "Connected", variant: "success" as const };
    case "pending":
      return { label: "Authorizing…", variant: "warning" as const };
    case "error":
      return { label: "Needs attention", variant: "danger" as const };
    default:
      return { label: "Not connected", variant: "outline" as const };
  }
}

export default function SecretaryPage() {
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { data, isInitialLoading } = useApi<SecretaryStatus>(STATUS_PATH);

  const configured = data?.configured ?? false;
  const connections = data?.connections ?? [];
  const statusFor = (tk: SecretaryToolkit): ConnectionStatus =>
    connections.find((c) => c.toolkit === tk)?.status ?? "disconnected";
  const anyActive = connections.some((c) => c.status === "active");

  const [busy, setBusy] = useState<string | null>(null); // `${action}:${toolkit}`
  const [error, setError] = useState<string | null>(null);
  const [briefing, setBriefing] = useState(false);

  // Stop any in-flight poll loop when we unmount.
  const pollAbort = useRef<{ cancelled: boolean } | null>(null);
  useEffect(() => () => { if (pollAbort.current) pollAbort.current.cancelled = true; }, []);

  async function handleConnect(tk: SecretaryToolkit) {
    setError(null);
    setBusy(`connect:${tk}`);
    try {
      const { redirectUrl } = await connectToolkit(tk);
      window.open(redirectUrl, "_blank", "noopener,noreferrer");
      // Poll for activation while the user authorizes in the popup/tab.
      const token = { cancelled: false };
      pollAbort.current = token;
      for (let i = 0; i < 40 && !token.cancelled; i++) {
        await new Promise((r) => setTimeout(r, 3000));
        if (token.cancelled) return;
        try {
          const { status } = await refreshToolkit(tk);
          if (status === "active") {
            await invalidateApi(STATUS_PATH);
            return;
          }
        } catch {
          /* transient: keep polling */
        }
      }
      await invalidateApi(STATUS_PATH);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the connection.");
    } finally {
      setBusy(null);
    }
  }

  async function handleDisconnect(tk: SecretaryToolkit, name: string) {
    const ok = await confirm({
      title: `Disconnect ${name}?`,
      message: <>The Secretary will lose access to your {name}. You can reconnect anytime.</>,
      confirmLabel: "Disconnect",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    setBusy(`disconnect:${tk}`);
    try {
      await disconnectToolkit(tk);
      await invalidateApi(STATUS_PATH);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not disconnect.");
    } finally {
      setBusy(null);
    }
  }

  async function handleBrief() {
    setError(null);
    setBriefing(true);
    try {
      const { run_id } = await generateBrief();
      navigate(`/agent/${run_id}`);
    } catch (err) {
      const parsed = err instanceof Error ? err.message : "Could not start the briefing.";
      setError(parsed);
      setBriefing(false);
    }
  }

  return (
    <div className="mx-auto flex h-screen w-full max-w-4xl flex-col overflow-y-auto scrollbar-thin px-6 py-8 md:px-10">
      {/* Header */}
      <div className="mb-6 flex items-start gap-3 pl-10 lg:pl-0">
        <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-ink text-surface">
          <Sparkles className="size-5" />
        </div>
        <div>
          <Eyebrow>Secretary</Eyebrow>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink">
            Secretary
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Your AI assistant for email and calendar. Reading is instant; anything that
            sends or changes something waits for your confirmation.
          </p>
        </div>
      </div>

      {/* Not-configured banner */}
      {!isInitialLoading && !configured && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-line bg-surface2 p-4">
          <KeyRound className="mt-0.5 size-5 shrink-0 text-muted" />
          <div className="text-sm">
            <p className="font-medium text-ink">The Secretary isn't configured yet</p>
            <p className="mt-0.5 text-muted">
              Add a <code className="rounded bg-surface px-1 py-0.5 text-xs">COMPOSIO_API_KEY</code>{" "}
              to your environment and restart the API to enable Gmail and Google Calendar.
              Everything below is a preview until then.
            </p>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 rounded-lg border border-line bg-surface2 px-4 py-3 text-sm text-ink">
          {error}
        </div>
      )}

      {/* Connection cards */}
      <div className="grid gap-4 sm:grid-cols-2">
        {isInitialLoading
          ? TOOLKITS.map((t) => <Skeleton key={t.key} className="h-40 rounded-2xl" />)
          : TOOLKITS.map((t, i) => {
              const status = statusFor(t.key);
              const badge = statusBadge(status);
              const connected = status === "active";
              const Icon = t.icon;
              const connecting = busy === `connect:${t.key}`;
              const disconnecting = busy === `disconnect:${t.key}`;
              return (
                <motion.div
                  key={t.key}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2, delay: Math.min(i * 0.05, 0.2) }}
                  className="flex flex-col rounded-lg border border-line bg-surface2 p-5"
                >
                  <div className="flex items-start justify-between">
                    <div className="grid size-11 place-items-center rounded-lg bg-ink text-surface">
                      <Icon className="size-5" />
                    </div>
                    {configured && (
                      <Badge variant={badge.variant}>
                        {status === "pending" && <Loader2 className="size-3 animate-spin" />}
                        {badge.label}
                      </Badge>
                    )}
                  </div>
                  <h3 className="mt-3 font-display text-base font-semibold text-ink">{t.name}</h3>
                  <p className="mt-1 flex-1 text-sm text-muted">{t.blurb}</p>
                  <div className="mt-4">
                    {connected ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-muted"
                        onClick={() => void handleDisconnect(t.key, t.name)}
                        disabled={disconnecting}
                      >
                        {disconnecting ? <Loader2 className="animate-spin" /> : <Unplug />}
                        Disconnect
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        onClick={() => void handleConnect(t.key)}
                        disabled={!configured || connecting}
                      >
                        {connecting ? <Loader2 className="animate-spin" /> : <PlugZap />}
                        {connecting ? "Waiting for authorization…" : "Connect"}
                      </Button>
                    )}
                  </div>
                </motion.div>
              );
            })}
      </div>

      {/* Today's brief */}
      <div className="mt-6 rounded-lg border border-line bg-surface2 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-ink text-surface">
              <Sparkles className="size-5" />
            </div>
            <div>
              <h3 className="font-display text-base font-semibold text-ink">Today's brief</h3>
              <p className="mt-0.5 max-w-md text-sm text-muted">
                A quick rundown of unread email since yesterday and today's schedule, with
                what needs a reply or your attention.
              </p>
            </div>
          </div>
          <Button onClick={() => void handleBrief()} disabled={briefing} className="shrink-0">
            {briefing ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {briefing ? "Starting…" : "Generate today's brief"}
          </Button>
        </div>
        {configured && !anyActive && (
          <p className="mt-3 text-xs text-muted">
            Tip: connect Gmail or Calendar above so the brief can read your real inbox and
            schedule. It will still run without them.
          </p>
        )}
      </div>

      {/* What the Secretary can do */}
      <div className="mt-6">
        <Eyebrow className="mb-3">What your Secretary can do</Eyebrow>
        <div className="grid gap-3 sm:grid-cols-3">
          <Capability
            icon={Eye}
            title="Read your inbox"
            body="Search, summarize, and pull out what matters. Runs instantly, no approval needed."
          />
          <Capability
            icon={Send}
            title="Draft & send"
            body="Compose replies and new emails. Every send is staged on a confirmation card first."
          />
          <Capability
            icon={Inbox}
            title="Manage your calendar"
            body="Check availability and schedule events. Creating or changing events asks you first."
          />
        </div>
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-line bg-surface2 px-4 py-3 text-xs text-muted">
          <ShieldCheck className="size-4 shrink-0 text-ink" />
          Nothing is sent, created, or deleted without your explicit confirmation. Your
          account tokens live in Composio, never in Omni.
        </div>
      </div>
    </div>
  );
}

function Capability({
  icon: Icon,
  title,
  body,
}: {
  icon: typeof Mail;
  title: string;
  body: string;
}) {
  return (
    <div className="rounded-lg border border-line bg-surface2 p-4">
      <div className="grid size-9 place-items-center rounded-lg bg-ink text-surface">
        <Icon className="size-4" />
      </div>
      <h3 className="mt-2.5 text-sm font-semibold text-ink">{title}</h3>
      <p className="mt-1 text-xs leading-relaxed text-muted">{body}</p>
    </div>
  );
}
