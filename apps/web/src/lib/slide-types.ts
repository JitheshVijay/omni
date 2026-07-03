// Slide-deck types — the web mirror of apps/api/src/generators/slides.ts.
// These MUST match the backend JSON shape byte-for-byte: they describe
// artifacts.content for kind='slides' (DeckContent) and are consumed by the
// SlideRenderer, the DeckViewer, and the .pptx export.
//
// The full Theme TOKEN SET is embedded in every deck's content, so the
// renderer and export are self-contained — they read deck.theme directly and
// never need a theme registry. THEME_PRESETS below is display-only, powering
// the theme picker on the generation form.

export interface Theme {
  id: string;
  name: string;
  /** Solid background fallback (equals bgFrom). */
  bg: string;
  bgFrom: string;
  bgTo: string;
  /** Card / panel surface painted on top of the slide background. */
  surface: string;
  text: string;
  textMuted: string;
  accent: string;
  accent2: string;
  border: string;
  fontHeading: string;
  fontBody: string;
}

export type Archetype =
  | "title"
  | "section"
  | "bullets"
  | "two-col"
  | "image+text"
  | "quote"
  | "chart";

interface SlideBase {
  notes?: string;
}

export interface TitleSlide extends SlideBase {
  archetype: "title";
  title: string;
  subtitle?: string;
  eyebrow?: string;
}

export interface SectionSlide extends SlideBase {
  archetype: "section";
  title: string;
  subtitle?: string;
}

export interface BulletsSlide extends SlideBase {
  archetype: "bullets";
  title: string;
  subtitle?: string;
  bullets: string[];
}

export interface Column {
  heading?: string;
  points: string[];
}

export interface TwoColSlide extends SlideBase {
  archetype: "two-col";
  title: string;
  left: Column;
  right: Column;
}

export interface ImageTextSlide extends SlideBase {
  archetype: "image+text";
  title: string;
  body: string[];
  image_prompt: string;
  /** Child image artifact id — resolve via /api/artifacts/<id>/blob. */
  image_artifact_id: string | null;
  image_side: "left" | "right";
  caption?: string;
}

export interface QuoteSlide extends SlideBase {
  archetype: "quote";
  quote: string;
  attribution?: string;
}

export interface ChartData {
  type: "bar" | "line" | "pie";
  categories: string[];
  values: number[];
  series_label?: string;
  unit?: string;
  caption?: string;
}

export interface ChartSlide extends SlideBase {
  archetype: "chart";
  title: string;
  chart: ChartData;
}

export type SlideSpec =
  | TitleSlide
  | SectionSlide
  | BulletsSlide
  | TwoColSlide
  | ImageTextSlide
  | QuoteSlide
  | ChartSlide;

export interface DeckContent {
  theme: Theme;
  slides: SlideSpec[];
}

/** The fixed design canvas every slide is authored against. */
export const SLIDE_W = 1280;
export const SLIDE_H = 720;

// Theme id -> picker metadata (label + swatch). The authoritative token set
// lives on the backend and rides inside each deck's content; this is only
// for the generation form's theme chooser.
export interface ThemePreset {
  id: string;
  name: string;
  swatch: [string, string, string];
}

export const THEME_PRESETS: ThemePreset[] = [
  { id: "midnight", name: "Midnight", swatch: ["#0B1020", "#818CF8", "#C4B5FD"] },
  { id: "daylight", name: "Daylight", swatch: ["#FFFFFF", "#4F46E5", "#7C3AED"] },
  { id: "sunrise", name: "Sunrise", swatch: ["#FFE7D3", "#E4572E", "#F2A03D"] },
  { id: "forest", name: "Forest", swatch: ["#0C1F17", "#34D399", "#A7F3D0"] },
];

export const ARCHETYPE_LABEL: Record<Archetype, string> = {
  title: "Title",
  section: "Section",
  bullets: "Bullets",
  "two-col": "Two columns",
  "image+text": "Image + text",
  quote: "Quote",
  chart: "Chart",
};
