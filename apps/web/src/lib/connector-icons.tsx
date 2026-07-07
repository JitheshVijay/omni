// Brand glyphs for the connector store. 19 of the 23 apps resolve to their
// official mark via simple-icons; the four that simple-icons removed on brand
// request (Slack, Salesforce, Pipedrive, LinkedIn) fall back to a colored
// monogram so every tile stays visually consistent (a coloured glyph on a
// white chip). All rendered inside a white tile, so brand colours read in
// both light and dark themes.
import type { ComponentType } from "react";
import {
  SiDiscord,
  SiGmail,
  SiNotion,
  SiGoogledocs,
  SiGoogledrive,
  SiGooglesheets,
  SiAirtable,
  SiConfluence,
  SiGithub,
  SiLinear,
  SiJira,
  SiGitlab,
  SiHubspot,
  SiGooglecalendar,
  SiAsana,
  SiTrello,
  SiClickup,
  SiX,
  SiReddit,
} from "@icons-pack/react-simple-icons";

type IconCmp = ComponentType<{ size?: number; color?: string; className?: string }>;

const ICONS: Record<string, IconCmp> = {
  discord: SiDiscord,
  gmail: SiGmail,
  notion: SiNotion,
  googledocs: SiGoogledocs,
  googledrive: SiGoogledrive,
  googlesheets: SiGooglesheets,
  airtable: SiAirtable,
  confluence: SiConfluence,
  github: SiGithub,
  linear: SiLinear,
  jira: SiJira,
  gitlab: SiGitlab,
  hubspot: SiHubspot,
  googlecalendar: SiGooglecalendar,
  asana: SiAsana,
  trello: SiTrello,
  clickup: SiClickup,
  twitter: SiX,
  reddit: SiReddit,
};

// Brand colours for the monogram fallbacks.
const FALLBACK_HEX: Record<string, string> = {
  slack: "#4A154B",
  salesforce: "#00A1E0",
  pipedrive: "#1A1A1A",
  linkedin: "#0A66C2",
};

function monogram(name: string): string {
  const words = name.replace(/[()]/g, "").trim().split(/\s+/);
  if (words.length >= 2 && words[0] && words[1]) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

/** The brand glyph for a connector — its official logo, or a coloured monogram. */
export function ConnectorGlyph({ toolkit, name }: { toolkit: string; name: string }) {
  const Icon = ICONS[toolkit];
  // color="default" uses each icon's official brand hex; without it the icons
  // inherit currentColor (white in dark mode) and vanish on the white tile.
  if (Icon) return <Icon size={22} color="default" />;
  return (
    <span
      className="font-display text-sm font-semibold"
      style={{ color: FALLBACK_HEX[toolkit] ?? "#111111" }}
    >
      {monogram(name)}
    </span>
  );
}
