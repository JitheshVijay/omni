// Full voice-call overlay: a pulsing mic orb that reacts to who's talking,
// a live transcript feed, connection status, and an End Call button. Manages
// the ElevenLabs session lifecycle for the duration it's open. When voice is
// unconfigured server-side it shows a setup nudge instead of a call.
import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, PhoneOff, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  startVoiceSession,
  type VoiceConnStatus,
  type VoiceMode,
  type VoiceSession,
  type VoiceTranscript,
} from "@/lib/voice-agent";

interface VoiceCallModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hubId?: string;
  hubName?: string;
}

export function VoiceCallModal({
  open,
  onOpenChange,
  hubId,
  hubName,
}: VoiceCallModalProps) {
  const [status, setStatus] = useState<VoiceConnStatus | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [mode, setMode] = useState<VoiceMode>("listening");
  const [transcripts, setTranscripts] = useState<VoiceTranscript[]>([]);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const sessionRef = useRef<VoiceSession | null>(null);
  const feedRef = useRef<HTMLDivElement>(null);

  // Start the call when the modal opens; tear it down on close / unmount.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;

    setStatus("connecting");
    setConfigured(null);
    setMode("listening");
    setTranscripts([]);
    setErrorMsg(null);

    void (async () => {
      try {
        const session = await startVoiceSession({
          hubId,
          onStatus: (s) => {
            if (!cancelled) setStatus(s);
          },
          onMode: (m) => {
            if (!cancelled) setMode(m);
          },
          onTranscript: (t) => {
            if (!cancelled) setTranscripts((prev) => [...prev, t]);
          },
          onError: (msg) => {
            if (!cancelled) setErrorMsg(msg);
          },
        });
        if (cancelled) {
          if (session.configured) void session.end();
          return;
        }
        if (!session.configured) {
          setConfigured(false);
          setStatus(null);
          return;
        }
        setConfigured(true);
        sessionRef.current = session;
      } catch (err) {
        if (cancelled) return;
        setStatus("error");
        setErrorMsg(
          err instanceof Error ? err.message : "Couldn't start the voice call.",
        );
      }
    })();

    return () => {
      cancelled = true;
      const handle = sessionRef.current;
      sessionRef.current = null;
      if (handle?.configured) void handle.end();
    };
  }, [open, hubId]);

  // Keep the transcript feed pinned to the latest turn.
  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight });
  }, [transcripts]);

  const active = status === "connected";
  const speaking = active && mode === "speaking";
  const listening = active && mode === "listening";

  const statusLine = errorMsg
    ? errorMsg
    : configured === false
      ? ""
      : status === "connecting"
        ? "Connecting…"
        : status === "disconnected"
          ? "Call ended."
          : speaking
            ? "Omni is speaking…"
            : listening
              ? "Listening. Go ahead."
              : "Connected.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-accent" />
          {hubName ? `Talk to ${hubName}` : "Talk to Omni"}
        </DialogTitle>
        <DialogDescription>
          {hubName
            ? "A live voice conversation grounded in this hub's memory."
            : "A live voice conversation with your Omni assistant."}
        </DialogDescription>

        {configured === false ? (
          <UnconfiguredNotice />
        ) : (
          <div className="flex flex-col items-center gap-5 py-2">
            <Orb speaking={speaking} listening={listening} connecting={status === "connecting"} />

            <p
              className={cn(
                "min-h-[1.25rem] text-center text-sm",
                errorMsg ? "text-rose-600 dark:text-rose-400" : "text-muted",
              )}
            >
              {statusLine}
            </p>

            {/* Transcript feed */}
            <div
              ref={feedRef}
              className="max-h-52 w-full overflow-y-auto scrollbar-thin rounded-xl border border-line bg-surface p-3"
            >
              {transcripts.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted">
                  Your conversation will appear here.
                </p>
              ) : (
                <ul className="flex flex-col gap-2.5">
                  {transcripts.map((t, i) => (
                    <li
                      key={i}
                      className={cn(
                        "flex flex-col gap-0.5",
                        t.role === "user" ? "items-end text-right" : "items-start",
                      )}
                    >
                      <span className="text-[10px] font-medium uppercase tracking-wide text-muted">
                        {t.role === "user" ? "You" : "Omni"}
                      </span>
                      <span
                        className={cn(
                          "max-w-[85%] rounded-2xl px-3 py-1.5 text-sm",
                          t.role === "user"
                            ? "bg-accent text-white"
                            : "bg-surface2 text-ink",
                        )}
                      >
                        {t.text}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <Button
              variant="destructive"
              className="w-full"
              onClick={() => onOpenChange(false)}
            >
              <PhoneOff />
              End call
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// The reactive mic orb. Pulses outward while the agent speaks (accent2) or
// while listening for the user (accent); a calm gradient when connecting.
function Orb({
  speaking,
  listening,
  connecting,
}: {
  speaking: boolean;
  listening: boolean;
  connecting: boolean;
}) {
  const active = speaking || listening;
  return (
    <div className="relative flex size-36 items-center justify-center">
      {/* Pulsing rings, only while actively talking/listening. */}
      {active && (
        <>
          <span
            className={cn(
              "absolute inset-0 rounded-full opacity-30 animate-ping",
              speaking ? "bg-accent2" : "bg-accent",
            )}
          />
          <span
            className={cn(
              "absolute inset-3 rounded-full opacity-40",
              speaking ? "bg-accent2/40" : "bg-accent/40",
            )}
          />
        </>
      )}
      {/* Core orb */}
      <div
        className={cn(
          "relative flex size-24 items-center justify-center rounded-full bg-gradient-to-br shadow-lg transition-transform duration-300",
          speaking
            ? "scale-110 from-accent2 to-accent"
            : listening
              ? "scale-105 from-accent to-accent2"
              : "from-accent/70 to-accent2/70",
        )}
      >
        {connecting ? (
          <Loader2 className="size-8 animate-spin text-white" />
        ) : (
          <Mic className="size-8 text-white" />
        )}
      </div>
    </div>
  );
}

function UnconfiguredNotice() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-line py-8 text-center">
      <Mic className="size-8 text-muted/50" />
      <p className="max-w-xs text-sm text-muted">
        Add{" "}
        <code className="rounded bg-ink/10 px-1 py-0.5 text-[11px] text-ink">
          ELEVENLABS_API_KEY
        </code>{" "}
        to your environment to talk to your hubs.
      </p>
    </div>
  );
}
