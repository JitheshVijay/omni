// Shared design-format + palette registry for the Design Studio pages. Mirrors
// the backend FORMATS/PALETTES in apps/api/src/generators/design.ts — the two
// MUST agree on ids and dimensions (the generated HTML canvas is sized to
// width×height and the viewer scales/exports against those same numbers).

export interface DesignFormat {
  id: string;
  label: string;
  width: number;
  height: number;
  category: string;
}

export const FORMATS: DesignFormat[] = [
  { id: "instagram-post", label: "Instagram Post", width: 1080, height: 1080, category: "Social" },
  { id: "instagram-story", label: "Instagram Story", width: 1080, height: 1920, category: "Social" },
  { id: "twitter-header", label: "Twitter / X Header", width: 1500, height: 500, category: "Social" },
  { id: "poster", label: "Poster", width: 1080, height: 1350, category: "Poster" },
  { id: "flyer", label: "Flyer (A4)", width: 1240, height: 1754, category: "Poster" },
  { id: "presentation-cover", label: "Presentation Cover", width: 1280, height: 720, category: "Marketing" },
  { id: "ad-banner", label: "Ad Banner", width: 1200, height: 628, category: "Marketing" },
  { id: "business-card", label: "Business Card", width: 1050, height: 600, category: "Personal" },
  { id: "logo", label: "Logo", width: 800, height: 800, category: "Branding" },
  { id: "document-cover", label: "Document Cover", width: 1240, height: 1754, category: "Document" },
];

// Category order for the selector tabs.
export const CATEGORIES = [
  "Social",
  "Poster",
  "Marketing",
  "Personal",
  "Branding",
  "Document",
] as const;
export type Category = (typeof CATEGORIES)[number];

export function getFormat(id: string | undefined | null): DesignFormat | undefined {
  return FORMATS.find((f) => f.id === id);
}

/** Formats grouped by category, in CATEGORIES order. */
export function formatsByCategory(): Record<string, DesignFormat[]> {
  const out: Record<string, DesignFormat[]> = {};
  for (const c of CATEGORIES) out[c] = [];
  for (const f of FORMATS) (out[f.category] ??= []).push(f);
  return out;
}

// ─── Palettes / design systems ──────────────────────────────────────

export type DesignPalette =
  | "vibrant"
  | "elegant"
  | "minimal"
  | "bold"
  | "pastel"
  | "dark-luxe";

export interface PaletteInfo {
  id: DesignPalette;
  label: string;
  description: string;
  // A three-stop swatch used for the picker chips (pure CSS, decorative).
  swatch: [string, string, string];
}

export const PALETTES: PaletteInfo[] = [
  {
    id: "vibrant",
    label: "Vibrant",
    description: "High-chroma color, bold gradients",
    swatch: ["#6366f1", "#ec4899", "#f59e0b"],
  },
  {
    id: "elegant",
    label: "Elegant",
    description: "Refined jewel tones, gold accents",
    swatch: ["#0f2c4d", "#7c5c2e", "#e8dcc5"],
  },
  {
    id: "minimal",
    label: "Minimal",
    description: "Monochrome, one restrained accent",
    swatch: ["#18181b", "#71717a", "#f4f4f5"],
  },
  {
    id: "bold",
    label: "Bold",
    description: "Loud type, flat blocky color",
    swatch: ["#ef4444", "#111827", "#facc15"],
  },
  {
    id: "pastel",
    label: "Pastel",
    description: "Soft, airy, friendly tones",
    swatch: ["#f9a8d4", "#a7f3d0", "#bfdbfe"],
  },
  {
    id: "dark-luxe",
    label: "Dark Luxe",
    description: "Deep dark canvas, metallic glow",
    swatch: ["#0b0b0f", "#c9a24b", "#3f3f46"],
  },
];

export function getPalette(id: string | undefined | null): PaletteInfo | undefined {
  return PALETTES.find((p) => p.id === id);
}

// ─── Example prompts (seed the composer, grouped by category) ───────

export interface DesignTemplate {
  id: string;
  title: string;
  category: Category;
  description: string;
  prompt: string;
  format: string;
  palette: DesignPalette;
}

export const DESIGN_TEMPLATES: DesignTemplate[] = [
  {
    id: "sale-post",
    title: "Flash sale post",
    category: "Social",
    description: "Square promo",
    prompt:
      "A square Instagram post announcing a 48-hour flash sale: “48H FLASH SALE — up to 50% off”, a bold discount badge, brand name “NOVA”, and a small “tap the link in bio” line.",
    format: "instagram-post",
    palette: "vibrant",
  },
  {
    id: "story-quote",
    title: "Quote story",
    category: "Social",
    description: "Vertical story",
    prompt:
      "A vertical Instagram story with an inspirational quote “Create the things you wish existed.” centered, an elegant author credit, and a soft decorative background.",
    format: "instagram-story",
    palette: "pastel",
  },
  {
    id: "event-poster",
    title: "Music event poster",
    category: "Poster",
    description: "Gig poster",
    prompt:
      "A striking concert poster for an indie band “The Midnight Echo”, Live at The Warehouse, Saturday Nov 22, doors 8pm, with a bold retro-modern layout and ticket info at the bottom.",
    format: "poster",
    palette: "bold",
  },
  {
    id: "workshop-flyer",
    title: "Workshop flyer",
    category: "Poster",
    description: "A4 flyer",
    prompt:
      "An A4 flyer for a weekend pottery workshop: title, a short blurb, what's included (clay, tools, glazing), date/time, location, price, and a “Reserve your spot” call to action.",
    format: "flyer",
    palette: "elegant",
  },
  {
    id: "deck-cover",
    title: "Pitch cover",
    category: "Marketing",
    description: "Title slide",
    prompt:
      "A widescreen presentation cover slide for a startup pitch: company name “Helio”, tagline “Solar storage for every home”, and a clean, confident background.",
    format: "presentation-cover",
    palette: "dark-luxe",
  },
  {
    id: "app-ad",
    title: "App download ad",
    category: "Marketing",
    description: "Banner ad",
    prompt:
      "A horizontal ad banner for a budgeting app “Ledger”: headline “Take control of your money”, a one-line value prop, and a clear “Download free” button.",
    format: "ad-banner",
    palette: "vibrant",
  },
  {
    id: "designer-card",
    title: "Designer card",
    category: "Personal",
    description: "Business card",
    prompt:
      "A minimalist business card front for “Ava Chen, Product Designer”, with an elegant monogram, email, phone, and website, balanced typography and lots of whitespace.",
    format: "business-card",
    palette: "minimal",
  },
  {
    id: "coffee-logo",
    title: "Coffee logo",
    category: "Branding",
    description: "Brand mark",
    prompt:
      "A centered logo for a specialty coffee roaster “Ember & Oak”, a simple emblem paired with a refined wordmark and a small “est. 2024” line, on a clean field.",
    format: "logo",
    palette: "elegant",
  },
  {
    id: "report-cover",
    title: "Report cover",
    category: "Document",
    description: "Cover page",
    prompt:
      "A polished cover for an annual sustainability report: title “2026 Impact Report”, subtitle, company name, and a sophisticated abstract background treatment.",
    format: "document-cover",
    palette: "dark-luxe",
  },
];
