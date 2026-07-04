// Launcher for the voice call. Drops anywhere the integrator wants a "Talk"
// affordance — a hub detail header, the chat header, etc. Reads the voice
// configured flag from /api/voice/voices; when voice isn't set up it renders
// a disabled button with an explanatory tooltip instead of a dead click.
import { useState } from "react";
import { Mic } from "lucide-react";
import { Button, type ButtonProps } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useApi } from "@/lib/use-api";
import { VoiceCallModal } from "@/components/voice/VoiceCallModal";

interface VoiceCallButtonProps {
  hubId?: string;
  hubName?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  className?: string;
  label?: string;
}

export function VoiceCallButton({
  hubId,
  hubName,
  variant = "secondary",
  size,
  className,
  label = "Talk",
}: VoiceCallButtonProps) {
  const [open, setOpen] = useState(false);
  // Cheap, cached, shared with the rest of the voice UI. `configured` is false
  // when ELEVENLABS_API_KEY is unset server-side.
  const { data } = useApi<{ configured: boolean }>("/api/voice/voices");
  const disabled = data?.configured === false;

  if (disabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Wrapper span: a disabled button doesn't fire the pointer events
              the tooltip needs to open. */}
          <span className={className}>
            <Button variant={variant} size={size} disabled className="w-full">
              <Mic />
              {label}
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          Add ELEVENLABS_API_KEY to talk to your hubs.
        </TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        onClick={() => setOpen(true)}
      >
        <Mic />
        {label}
      </Button>
      <VoiceCallModal
        open={open}
        onOpenChange={setOpen}
        hubId={hubId}
        hubName={hubName}
      />
    </>
  );
}
