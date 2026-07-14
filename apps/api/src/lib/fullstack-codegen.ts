// Full-stack project codegen for the App Builder. To keep generated apps
// reliably runnable AND good-looking, the TOOLCHAIN is fixed here — a Vite +
// React 18 frontend styled with Tailwind and a shadcn-style design-token system
// (HSL CSS variables + pre-built UI primitives), plus an Express + better-sqlite3
// API wired so Vite proxies /api to the server. The LLM only fills in the app
// logic and UI, so it never has to invent a build config or a design system; it
// composes a beautiful app from a known-good, opinionated foundation.
//
// Pipeline: planApp() writes a short design+build brief (name, color theme,
// screens, data model, features) -> generateFullstackProject() renders the app
// against that brief -> repairFullstackProject() fixes build errors in a loop.
import { callLLMJSON, MODELS, logger, streamLLM } from "@omni/sdk";
import type { ProjectFile } from "./e2b.js";

function normPath(p: string): string {
  return p.replace(/^\/+/, "").trim();
}

export interface GeneratedProject {
  name: string;
  summary: string;
  files: ProjectFile[];
  installCmd: string;
  devCmd: string;
  previewPort: number;
}

export const PREVIEW_PORT = 5173;
export const INSTALL_CMD = "npm install";
export const DEV_CMD = "npm run dev";
export const BUILD_CMD = "npm run build";
const API_PORT = 3001;

// The toolchain/config is owned by the scaffold and never handed to the model.
// Everything else under src/** and server/** is fair game — including index.css
// and the UI primitives, which the model may extend to build the design system.
const IMMUTABLE_PATHS = new Set([
  "package.json",
  "vite.config.js",
  "tailwind.config.js",
  "postcss.config.js",
  "index.html",
  "src/main.jsx",
  "src/lib/utils.js",
  "server/ai.js",
  "public/manifest.webmanifest",
  "public/icon.svg",
  ".gitignore",
  "render.yaml",
  "README.md",
]);
const EDITABLE_PREFIXES = ["src/", "server/"];
export function isEditable(path: string): boolean {
  return !IMMUTABLE_PATHS.has(path) && EDITABLE_PREFIXES.some((p) => path.startsWith(p));
}

// ── design brief ─────────────────────────────────────────────────────────────
type Platform = "web" | "mobile";

interface Brief {
  name: string;
  summary: string;
  platform: Platform;
  theme: { primary: string; vibe: string };
  pages: string[];
  dataModel: string[];
  features: string[];
}

interface RawBrief {
  name?: string;
  summary?: string;
  platform?: string;
  theme?: { primary?: string; vibe?: string };
  pages?: unknown;
  dataModel?: unknown;
  features?: unknown;
}

const PLAN_SYSTEM = [
  "You are a senior product designer and full-stack architect. Given an app idea, produce a tight build brief that a strong engineer can execute: a name, a one-line summary, the target platform, a color theme, the screens, the data model, and the core features.",
  "Pick a color palette that fits the product's domain and feels modern and premium — the bar is a well-designed Linear / Vercel / Stripe / Cal.com app. Prefer a confident, saturated primary color with real personality over a generic gray.",
  'Choose the platform that fits how the app is really used: "mobile" for anything primarily used on a phone (camera/photo capture, food/nutrition, fitness/health, habit/mood trackers, social feeds, check-ins, POS, field/on-the-go tools); "web" for dashboards, admin panels, editors, tables, B2B tools, and content sites. When in doubt, prefer web.',
  "Scope a focused, genuinely useful MVP: a few real screens with real data, not a kitchen sink.",
].join("\n");

function strList(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, max);
}

function defaultBrief(prompt: string): Brief {
  return {
    name: "omni-app",
    summary: prompt.slice(0, 140),
    platform: "web",
    theme: { primary: "240 5.9% 10%", vibe: "clean and modern" },
    pages: [],
    dataModel: [],
    features: [],
  };
}

function normalizeBrief(raw: RawBrief, prompt: string): Brief {
  const primary = typeof raw.theme?.primary === "string" ? raw.theme.primary.trim() : "";
  return {
    name: (raw.name || "omni-app").replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 40) || "omni-app",
    summary: raw.summary?.trim() || prompt.slice(0, 140),
    platform: raw.platform?.trim().toLowerCase() === "mobile" ? "mobile" : "web",
    theme: {
      primary: /^\d/.test(primary) ? primary : "240 5.9% 10%",
      vibe: raw.theme?.vibe?.trim() || "clean and modern",
    },
    pages: strList(raw.pages, 8),
    dataModel: strList(raw.dataModel, 12),
    features: strList(raw.features, 12),
  };
}

/** Design + product brief that steers codegen. Fail-soft to a default brief. */
async function planApp(prompt: string): Promise<Brief> {
  try {
    const raw = await callLLMJSON<RawBrief>({
      system: PLAN_SYSTEM,
      prompt:
        `App idea: ${prompt}\n\n` +
        'Respond with JSON: {' +
        '"name": string (kebab-case, short), ' +
        '"summary": string (one sentence), ' +
        '"platform": "web" | "mobile" (see the platform guidance), ' +
        '"theme": {"primary": "an HSL triplet WITHOUT the hsl() wrapper and WITHOUT commas, e.g. \\"160 84% 39%\\" for emerald or \\"221 83% 53%\\" for blue", "vibe": string (2-4 words on the visual mood)}, ' +
        '"pages": string[] (each: screen name + one-line purpose), ' +
        '"dataModel": string[] (each: table name + columns), ' +
        '"features": string[] (the core user-facing features)}.',
      model: MODELS.agent,
      maxTokens: 3000,
    });
    return normalizeBrief(raw, prompt);
  } catch {
    return defaultBrief(prompt);
  }
}

function briefBlock(brief: Brief): string {
  const lines = [
    `Product: ${brief.summary}`,
    `Platform: ${brief.platform === "mobile" ? "mobile (phone-first web app)" : "web"}`,
    `Visual mood: ${brief.theme.vibe}`,
  ];
  if (brief.pages.length) lines.push(`Screens:\n${brief.pages.map((p) => `  - ${p}`).join("\n")}`);
  if (brief.dataModel.length) lines.push(`Data model:\n${brief.dataModel.map((d) => `  - ${d}`).join("\n")}`);
  if (brief.features.length) lines.push(`Core features:\n${brief.features.map((f) => `  - ${f}`).join("\n")}`);
  return lines.join("\n");
}

// ── fixed scaffold: guaranteed-runnable toolchain + design system ────────────
function primaryForeground(primary: string): string {
  const l = parseFloat(primary.trim().split(/\s+/)[2] ?? "");
  // Light text on dark/vivid primaries, dark text on light ones.
  return Number.isFinite(l) && l >= 62 ? "240 10% 3.9%" : "0 0% 98%";
}

// Convert an "H S% L%" token to a #rrggbb hex, for places that need a real color
// value rather than a CSS var (PWA theme-color, manifest, generated icon).
function hslToHex(hsl: string): string {
  const p = hsl.trim().split(/\s+/);
  const h = parseFloat(p[0]);
  const s = parseFloat(p[1]) / 100;
  const l = parseFloat(p[2]) / 100;
  if (![h, s, l].every(Number.isFinite)) return "#111827";
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g] = [c, x];
  else if (h < 120) [r, g] = [x, c];
  else if (h < 180) [g, b] = [c, x];
  else if (h < 240) [g, b] = [x, c];
  else if (h < 300) [r, b] = [x, c];
  else [r, b] = [c, x];
  const to = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

// index.css carries the whole design system: Tailwind layers + the HSL token set
// (light + dark), themed with the brief's primary color so every app has its own
// identity out of the box. The model may edit this to refine the palette. For
// mobile, extra base rules make it feel native (full-height, safe areas, no
// overscroll/tap-highlight) plus dvh + safe-area utility classes.
function themedIndexCss(theme: { primary: string }, platform: Platform): string {
  const primary = theme.primary;
  const pfg = primaryForeground(primary);
  const mobileBase =
    platform === "mobile"
      ? `
@layer base {
  html, body, #root { height: 100%; }
  body {
    overscroll-behavior-y: none;
    -webkit-text-size-adjust: 100%;
    -webkit-tap-highlight-color: transparent;
    -webkit-user-select: none;
    user-select: none;
  }
  input, textarea, [contenteditable] { -webkit-user-select: auto; user-select: auto; }
}

@layer utilities {
  /* h-dvh / min-h-dvh are built into Tailwind 3.4; only safe-area insets need defining. */
  .pt-safe { padding-top: max(env(safe-area-inset-top), 0.5rem); }
  .pb-safe { padding-bottom: max(env(safe-area-inset-bottom), 0.5rem); }
}
`
      : "";
  return `@tailwind base;
@tailwind components;
@tailwind utilities;

@layer base {
  :root {
    --background: 0 0% 100%;
    --foreground: 240 10% 3.9%;
    --card: 0 0% 100%;
    --card-foreground: 240 10% 3.9%;
    --popover: 0 0% 100%;
    --popover-foreground: 240 10% 3.9%;
    --primary: ${primary};
    --primary-foreground: ${pfg};
    --secondary: 240 4.8% 95.9%;
    --secondary-foreground: 240 5.9% 10%;
    --muted: 240 4.8% 95.9%;
    --muted-foreground: 240 3.8% 46.1%;
    --accent: 240 4.8% 95.9%;
    --accent-foreground: 240 5.9% 10%;
    --destructive: 0 72% 51%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 5.9% 90%;
    --input: 240 5.9% 90%;
    --ring: ${primary};
    --radius: 0.75rem;
  }

  .dark {
    --background: 240 10% 3.9%;
    --foreground: 0 0% 98%;
    --card: 240 10% 5.5%;
    --card-foreground: 0 0% 98%;
    --popover: 240 10% 5.5%;
    --popover-foreground: 0 0% 98%;
    --primary: ${primary};
    --primary-foreground: ${pfg};
    --secondary: 240 3.7% 15.9%;
    --secondary-foreground: 0 0% 98%;
    --muted: 240 3.7% 15.9%;
    --muted-foreground: 240 5% 64.9%;
    --accent: 240 3.7% 15.9%;
    --accent-foreground: 0 0% 98%;
    --destructive: 0 62.8% 45%;
    --destructive-foreground: 0 0% 98%;
    --border: 240 3.7% 16%;
    --input: 240 3.7% 16%;
    --ring: ${primary};
  }
}

@layer base {
  * { border-color: hsl(var(--border)); }
  html { -webkit-font-smoothing: antialiased; }
  body {
    margin: 0;
    background-color: hsl(var(--background));
    color: hsl(var(--foreground));
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
}
${mobileBase}`;
}

const TAILWIND_CONFIG = `/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: { DEFAULT: "hsl(var(--primary))", foreground: "hsl(var(--primary-foreground))" },
        secondary: { DEFAULT: "hsl(var(--secondary))", foreground: "hsl(var(--secondary-foreground))" },
        destructive: { DEFAULT: "hsl(var(--destructive))", foreground: "hsl(var(--destructive-foreground))" },
        muted: { DEFAULT: "hsl(var(--muted))", foreground: "hsl(var(--muted-foreground))" },
        accent: { DEFAULT: "hsl(var(--accent))", foreground: "hsl(var(--accent-foreground))" },
        popover: { DEFAULT: "hsl(var(--popover))", foreground: "hsl(var(--popover-foreground))" },
        card: { DEFAULT: "hsl(var(--card))", foreground: "hsl(var(--card-foreground))" },
      },
      borderRadius: {
        xl: "calc(var(--radius) + 4px)",
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "fade-in": { from: { opacity: "0", transform: "translateY(4px)" }, to: { opacity: "1", transform: "translateY(0)" } },
      },
      animation: { "fade-in": "fade-in 0.3s ease-out" },
    },
  },
  plugins: [],
};
`;

const POSTCSS_CONFIG = `export default {
  plugins: {
    tailwindcss: {},
    autoprefixer: {},
  },
};
`;

const UTILS_JS = `import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Merge Tailwind class strings, resolving conflicts (later wins).
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}
`;

const BUTTON_JSX = `import { cva } from "class-variance-authority";
import { cn } from "../../lib/utils.js";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90 shadow-sm",
      },
      size: { default: "h-10 px-4 py-2", sm: "h-9 px-3", lg: "h-11 px-6 text-base", icon: "h-10 w-10" },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export function Button({ className, variant, size, ...props }) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { buttonVariants };
`;

const CARD_JSX = `import { cn } from "../../lib/utils.js";

export function Card({ className, ...props }) {
  return <div className={cn("rounded-xl border bg-card text-card-foreground shadow-sm", className)} {...props} />;
}
export function CardHeader({ className, ...props }) {
  return <div className={cn("flex flex-col space-y-1.5 p-6", className)} {...props} />;
}
export function CardTitle({ className, ...props }) {
  return <h3 className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />;
}
export function CardDescription({ className, ...props }) {
  return <p className={cn("text-sm text-muted-foreground", className)} {...props} />;
}
export function CardContent({ className, ...props }) {
  return <div className={cn("p-6 pt-0", className)} {...props} />;
}
export function CardFooter({ className, ...props }) {
  return <div className={cn("flex items-center p-6 pt-0", className)} {...props} />;
}
`;

const INPUT_JSX = `import { cn } from "../../lib/utils.js";

export function Input({ className, type, ...props }) {
  return (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
`;

const BADGE_JSX = `import { cn } from "../../lib/utils.js";

const variants = {
  default: "border-transparent bg-primary text-primary-foreground",
  secondary: "border-transparent bg-secondary text-secondary-foreground",
  outline: "text-foreground",
  destructive: "border-transparent bg-destructive text-destructive-foreground",
};

export function Badge({ className, variant = "default", ...props }) {
  return (
    <div
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors",
        variants[variant] || variants.default,
        className,
      )}
      {...props}
    />
  );
}
`;

// server/ai.js — the app-scoped AI helper. Omni injects OPENROUTER_API_KEY and
// the model names into the sandbox env at runtime, so generated apps get REAL
// AI (text + vision) without the model ever hardcoding a key. Written with
// string concatenation (no template literals) so it embeds cleanly here.
const AI_JS = `// AI helper for this app, provided by Omni. Reads the key + model names from the
// environment (injected when the app runs) — never hardcode a key. OpenRouter's
// OpenAI-compatible chat API. See the exported functions below.
const KEY = process.env.OPENROUTER_API_KEY || "";
const BASE = process.env.OMNI_AI_BASE_URL || "https://openrouter.ai/api/v1";
const TEXT_MODEL = process.env.OMNI_AI_MODEL || "anthropic/claude-sonnet-5";
const VISION_MODEL = process.env.OMNI_AI_VISION_MODEL || TEXT_MODEL;

/** True when AI is available. Check this and degrade gracefully if false. */
export function aiConfigured() {
  return KEY.length > 0;
}

async function chat(messages, opts) {
  opts = opts || {};
  if (!KEY) throw new Error("AI is not configured (OPENROUTER_API_KEY is missing).");
  const res = await fetch(BASE + "/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: opts.model || TEXT_MODEL,
      messages: messages,
      max_tokens: opts.maxTokens || 1024,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs || 60000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(function () { return ""; });
    throw new Error("AI request failed (" + res.status + "): " + detail.slice(0, 300));
  }
  const data = await res.json();
  return (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "";
}

/** Ask the model a question; returns text. opts: { system, model, maxTokens }. */
export async function askAI(prompt, opts) {
  opts = opts || {};
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  return chat(messages, opts);
}

function extractJSON(s) {
  const t = String(s);
  const idxs = [t.indexOf("{"), t.indexOf("[")].filter(function (i) { return i >= 0; });
  if (!idxs.length) return t.trim();
  const first = Math.min.apply(null, idxs);
  const last = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  return last > first ? t.slice(first, last + 1) : t.trim();
}

/** Ask the model for JSON; returns a parsed object/array. */
export async function askAIJSON(prompt, opts) {
  opts = opts || {};
  const system = (opts.system ? opts.system + "\\n\\n" : "") + "Respond with ONLY valid JSON. No prose, no markdown code fences.";
  const text = await askAI(prompt, Object.assign({}, opts, { system: system }));
  return JSON.parse(extractJSON(text));
}

/** Analyze an image with a prompt. imageUrl is a data: URL or an https URL.
 *  Returns text (ask for JSON in the prompt if you want to parse it). */
export async function askAIVision(prompt, imageUrl, opts) {
  opts = opts || {};
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({
    role: "user",
    content: [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: imageUrl } },
    ],
  });
  return chat(messages, Object.assign({}, opts, { model: opts.model || VISION_MODEL }));
}
`;

// Shared guidance appended to the codegen/edit prompts so the model wires REAL
// AI through server/ai.js instead of faking or stubbing intelligent features.
const AI_GUIDE = [
  "AI CAPABILITY (real, not mocked): the backend can call an LLM through the provided helper file server/ai.js. Use it for any feature that needs understanding, extraction, classification, generation, or image analysis. NEVER fabricate AI output, and NEVER hardcode an API key or call an AI provider directly.",
  '  import { askAI, askAIJSON, askAIVision, aiConfigured } from "./ai.js";',
  "  - askAI(prompt, { system?, maxTokens? }) -> string",
  "  - askAIJSON(prompt, { system? }) -> parsed JSON (best for structured extraction/classification)",
  "  - askAIVision(prompt, imageDataUrl, { system? }) -> string (analyze a photo; imageDataUrl is a base64 data: URL)",
  "  Call these inside your /api endpoints. Guard with aiConfigured() and return a helpful message when it is false.",
  '  For photo features: capture the image in the browser (an <input type="file" accept="image/*"> or the camera), read it as a base64 data URL, POST it to your backend, and call askAIVision there. Set express.json({ limit: "12mb" }) so image payloads fit.',
].join("\n");

// ── mobile form factor ───────────────────────────────────────────────────────
// A native-feeling phone shell (editable primitive) plus PWA assets. Same
// Vite/React/Tailwind toolchain — no separate mobile build system.
const MOBILE_JS = `import { cn } from "../../lib/utils.js";

// Native-feeling mobile shell. Wrap the whole app in <Screen>. On a phone it
// fills the viewport; on a wide screen it centers as a phone-sized frame.
export function Screen({ className, children }) {
  return (
    <div className="flex min-h-dvh w-full justify-center bg-muted">
      <div
        className={cn(
          "relative flex h-dvh w-full max-w-md flex-col overflow-hidden bg-background sm:border-x sm:border-border sm:shadow-xl",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}

// Scrollable content area between the app bar and the tab bar.
export function ScreenContent({ className, ...props }) {
  return <main className={cn("flex-1 overflow-y-auto overscroll-contain", className)} {...props} />;
}

// Sticky top bar; handles the top safe area.
export function AppBar({ className, ...props }) {
  return (
    <header
      className={cn(
        "shrink-0 border-b border-border bg-background/80 px-4 pb-3 pt-safe backdrop-blur-md",
        className,
      )}
      {...props}
    />
  );
}

// Bottom tab bar; handles the bottom safe area.
export function TabBar({ className, ...props }) {
  return (
    <nav
      className={cn(
        "flex shrink-0 items-stretch border-t border-border bg-background/90 pb-safe backdrop-blur-md",
        className,
      )}
      {...props}
    />
  );
}

// A single tab. Pass a lucide icon component as \`icon\`, plus \`label\` and \`active\`.
export function TabItem({ className, active, icon: Icon, label, ...props }) {
  return (
    <button
      type="button"
      className={cn(
        "flex flex-1 flex-col items-center justify-center gap-1 py-2 text-[11px] font-medium transition-transform active:scale-95",
        active ? "text-primary" : "text-muted-foreground",
        className,
      )}
      {...props}
    >
      {Icon ? <Icon className="size-6" /> : null}
      {label ? <span>{label}</span> : null}
    </button>
  );
}
`;

const MOBILE_GUIDE = [
  "MOBILE APP MODE: build a MOBILE-FIRST app that looks and feels like a polished native iOS/Android app on a phone. The bar is a top App Store app.",
  "- Wrap the entire app in the Screen shell from src/components/ui/mobile.jsx, which also exports ScreenContent (scrollable body), AppBar (sticky top bar), TabBar and TabItem (bottom navigation). Layout: <Screen><AppBar/><ScreenContent>…</ScreenContent><TabBar>…TabItems…</TabBar></Screen>.",
  "- Primary navigation is a bottom TabBar with 3-5 TabItems (lucide icon + short label); track the active tab with useState (or react-router). Only ScreenContent scrolls; AppBar and TabBar stay fixed.",
  "- Touch-first: large tap targets (min height h-12), big rounded-2xl cards, generous spacing, bottom-sheet style dialogs that slide up from the bottom, tappable rows. No hover-only interactions.",
  "- Respect safe areas (the shell primitives already apply pt-safe / pb-safe). Keep everything within the phone width; never build a wide desktop layout.",
  "- Feel native: a greeting/header, section headers, large numbers or progress rings for key metrics, subtle dividers, momentum scrolling; use the animate-fade-in utility for entering content.",
  '- Camera/photo features: use <input type="file" accept="image/*" capture="environment" /> (opens the camera on phones) or navigator.mediaDevices.getUserMedia for a live viewfinder; read the photo as a base64 data URL and POST it to the backend for askAIVision (see the AI section).',
].join("\n");

function indexHtml(platform: Platform, themeHex: string): string {
  if (platform !== "mobile") {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`;
  }
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=1.0, user-scalable=no" />
    <meta name="theme-color" content="${themeHex}" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="apple-touch-icon" href="/icon.svg" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`;
}

function manifestJson(themeHex: string): string {
  return JSON.stringify(
    {
      name: "App",
      short_name: "App",
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#ffffff",
      theme_color: themeHex,
      icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
    },
    null,
    2,
  );
}

function iconSvg(themeHex: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="112" fill="${themeHex}" />
  <circle cx="256" cy="256" r="118" fill="#ffffff" fill-opacity="0.92" />
  <circle cx="256" cy="256" r="58" fill="${themeHex}" />
</svg>
`;
}

// Files the model MUST NOT touch (toolchain). Everything else here is a starting
// point the model may override by returning a file at the same path.
function scaffoldFiles(theme: { primary: string }, platform: Platform): ProjectFile[] {
  const themeHex = hslToHex(theme.primary);
  const files: ProjectFile[] = [
    {
      path: "package.json",
      content: JSON.stringify(
        {
          name: "omni-app",
          private: true,
          type: "module",
          scripts: {
            dev: `concurrently -k -n api,web "node --watch server/index.js" "vite --host --port ${PREVIEW_PORT}"`,
            build: "vite build",
            start: "node server/index.js",
          },
          dependencies: {
            express: "^4.19.2",
            "better-sqlite3": "^11.3.0",
            react: "^18.3.1",
            "react-dom": "^18.3.1",
            "react-router-dom": "^6.27.0",
            "lucide-react": "^0.454.0",
            clsx: "^2.1.1",
            "tailwind-merge": "^2.5.4",
            "class-variance-authority": "^0.7.0",
          },
          devDependencies: {
            vite: "^5.4.8",
            "@vitejs/plugin-react": "^4.3.1",
            concurrently: "^9.0.1",
            tailwindcss: "^3.4.14",
            postcss: "^8.4.47",
            autoprefixer: "^10.4.20",
          },
        },
        null,
        2,
      ),
    },
    {
      path: "vite.config.js",
      content: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// host:true + allowedHosts:true so the public E2B preview host can reach the dev
// server; /api is proxied to the Express server so the app is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: ${PREVIEW_PORT},
    allowedHosts: true,
    proxy: { "/api": "http://localhost:${API_PORT}" },
  },
});
`,
    },
    { path: "tailwind.config.js", content: TAILWIND_CONFIG },
    { path: "postcss.config.js", content: POSTCSS_CONFIG },
    { path: "index.html", content: indexHtml(platform, themeHex) },
    {
      path: "src/main.jsx",
      content: `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
    },
    { path: "src/index.css", content: themedIndexCss(theme, platform) },
    { path: "src/lib/utils.js", content: UTILS_JS },
    { path: "src/components/ui/button.jsx", content: BUTTON_JSX },
    { path: "src/components/ui/card.jsx", content: CARD_JSX },
    { path: "src/components/ui/input.jsx", content: INPUT_JSX },
    { path: "src/components/ui/badge.jsx", content: BADGE_JSX },
    { path: "server/ai.js", content: AI_JS },
    { path: ".gitignore", content: "node_modules\ndist\n*.db\n*.db-journal\n.env\n" },
    {
      path: "render.yaml",
      content: `services:
  - type: web
    name: omni-app
    runtime: node
    plan: free
    buildCommand: npm install && npm run build
    startCommand: npm start
    envVars:
      # AI features read this at runtime. Render will prompt you for the value
      # on deploy (it is never committed to the repo).
      - key: OPENROUTER_API_KEY
        sync: false
`,
    },
    {
      path: "README.md",
      content: `# Full-stack app

Generated by Omni. Vite + React + Tailwind frontend, Express + better-sqlite3 backend.

## Run locally
\`\`\`
npm install
npm run dev      # http://localhost:${PREVIEW_PORT}
\`\`\`

## Deploy
Includes a \`render.yaml\` Blueprint. Use the "Deploy to Render" link Omni gives
you, or connect this repo in the Render dashboard. Note: SQLite lives on the
instance's disk, so data resets on redeploy unless you attach a persistent disk.
`,
    },
  ];

  if (platform === "mobile") {
    files.push(
      { path: "src/components/ui/mobile.jsx", content: MOBILE_JS },
      { path: "public/manifest.webmanifest", content: manifestJson(themeHex) },
      { path: "public/icon.svg", content: iconSvg(themeHex) },
    );
  }
  return files;
}

const SYSTEM = [
  "You are an elite full-stack product engineer with the taste of a top design studio. You write the APP CODE for a project whose toolchain is already set up: a Vite + React 18 frontend styled with Tailwind and a shadcn-style design system, and an Express + better-sqlite3 backend, with Vite proxying /api to Express on port " + API_PORT + ".",
  "",
  "Your output must look like a real, shipped, premium product — the bar is Linear / Vercel / Stripe / Cal.com. Design quality matters as much as functionality. Ugly or generic output is a failure.",
  "",
  "ALREADY PROVIDED — do NOT output these (they exist and are correct): package.json, vite.config.js, tailwind.config.js, postcss.config.js, index.html, src/main.jsx, src/lib/utils.js.",
  "",
  "DESIGN SYSTEM you build on:",
  "- Tailwind is configured with semantic color tokens: bg-background, text-foreground, bg-card/text-card-foreground, bg-primary/text-primary-foreground, bg-secondary, bg-muted/text-muted-foreground, bg-accent, border-border, bg-destructive, plus ring-ring and rounded-lg/xl driven by --radius. The brand color is already themed for this app.",
  "- Pre-built primitives exist and you SHOULD use and extend them: `Button` (src/components/ui/button.jsx — variants default/secondary/outline/ghost/destructive, sizes sm/default/lg/icon), `Card`/`CardHeader`/`CardTitle`/`CardDescription`/`CardContent`/`CardFooter` (card.jsx), `Input` (input.jsx), `Badge` (badge.jsx), and `cn()` (src/lib/utils.js). Add more components in src/components/** in the same style.",
  "- Icons: import from `lucide-react` (e.g. `import { Plus, Trash2 } from 'lucide-react'`). Use them for every action/affordance.",
  "- You MAY refine the palette by editing src/index.css, but you MUST keep the three @tailwind directives and the token variables intact.",
  "",
  "DESIGN RULES (non-negotiable):",
  "- Use ONLY the semantic tokens above. NEVER hardcode colors like bg-white, bg-black, text-gray-500, bg-slate-900 — always the tokens, so light/dark and theming work.",
  "- Strong visual hierarchy: a real header/nav, generous whitespace (p-6/gap-6), large confident headings, rounded-xl cards with subtle borders and shadow-sm. No cramped, unstyled forms.",
  "- Fully responsive, mobile-first (flex/grid, max-w containers, sensible breakpoints).",
  "- Every list/data view has proper LOADING (skeleton or spinner), EMPTY (illustration/icon + message + primary action), and ERROR states. Never render a blank screen.",
  "- Tasteful motion and interactivity: hover states, transitions, focus rings, the `animate-fade-in` utility for entering content. Polished, not cluttered.",
  "",
  "REQUIRED FILES:",
  "- src/App.jsx (required): the root component and the app's real UI. Compose it from components under src/. If the app has multiple screens, use react-router-dom (BrowserRouter/Routes/Route or a simple tab state) — your choice.",
  "- server/index.js (required): an Express app. Listen on process.env.PORT || " + API_PORT + ". Use better-sqlite3 with new Database(process.env.DATABASE_PATH || 'data.db'); create tables on startup if missing; enable express.json(); expose real JSON REST endpoints under /api/*. FOR PRODUCTION also serve the built frontend: import { existsSync } from 'node:fs'; if a 'dist' directory exists, app.use(express.static('dist')) and add a non-/api GET fallback returning dist/index.html (guard it so it never intercepts /api). In dev 'dist' is absent so this is a no-op.",
  "",
  "ENGINEERING RULES:",
  "- The frontend talks to the backend with fetch('/api/...') (same-origin via the proxy). Never hardcode a host or port.",
  "- ES modules everywhere (package.json has \"type\":\"module\").",
  "- Genuinely functional and persistent: real routes, real DB reads/writes, real state — not a mockup. Seed a little sample data on first run so the app never looks empty on first load.",
  "- Allowed dependencies ONLY: react, react-dom, react-router-dom, lucide-react, clsx, tailwind-merge, class-variance-authority, express, better-sqlite3. No other npm packages, no CDNs, no external network calls, no image URLs from the internet (use gradients, colors, and lucide icons instead).",
  "- Do not invent secrets or credentials.",
  "",
  AI_GUIDE,
].join("\n");

interface RawGen {
  name?: string;
  summary?: string;
  files?: { path?: string; content?: string }[];
}

function cleanFiles(raw: RawGen): ProjectFile[] {
  return (raw.files ?? [])
    .filter((f): f is { path: string; content: string } =>
      typeof f?.path === "string" && typeof f?.content === "string" && f.path.trim().length > 0,
    )
    .map((f) => ({ path: f.path.replace(/^\/+/, "").trim(), content: f.content }));
}

/** Merge the model's files onto the scaffold: toolchain is protected, editable
 *  base files (index.css, primitives) are overridden if returned, new files added. */
function assemble(scaffold: ProjectFile[], llmFiles: ProjectFile[]): ProjectFile[] {
  const byPath = new Map(scaffold.map((f) => [f.path, f]));
  for (const f of llmFiles) {
    if (IMMUTABLE_PATHS.has(f.path)) continue;
    byPath.set(f.path, f);
  }
  return [...byPath.values()];
}

function buildInstruction(prompt: string, brief: Brief): string {
  return (
    `Build this app.\n\nUser request: ${prompt}\n\nBuild brief:\n${briefBlock(brief)}\n\n` +
    "Deliver the full app: a polished src/App.jsx (plus components under src/), and a complete server/index.js with real endpoints and persistence for the data model above. " +
    "Build a FOCUSED MVP: the screens and features in the brief, done really well. Split the UI into sensible components (aim for roughly 6-14 source files); do NOT pad with extra screens, settings pages, or features nobody asked for."
  );
}

// Streamed output format: a sequence of verbatim file blocks (Bolt-style). Far
// easier to parse incrementally than JSON, and file content needs no escaping.
const STREAM_FORMAT = [
  "",
  "OUTPUT FORMAT — output ONLY a sequence of file blocks in this EXACT format and NOTHING else (no prose, no JSON, no markdown code fences, no commentary before, between, or after the blocks):",
  '<omni-file path="server/index.js">',
  "...the complete file content, verbatim...",
  "</omni-file>",
  '<omni-file path="src/App.jsx">',
  "...",
  "</omni-file>",
  "",
  "Rules: one block per file; path is relative (e.g. src/components/Foo.jsx); put the raw file content between the tags with NO escaping and NO code fences; emit server/index.js and src/App.jsx FIRST, then supporting components; do NOT emit the pre-provided files (package.json, vite.config.js, tailwind.config.js, postcss.config.js, index.html, src/main.jsx, src/lib/utils.js, server/ai.js).",
].join("\n");

const JSON_FORMAT =
  '\n\nRespond with JSON: {"name": string, "summary": string, "files": [{"path": string, "content": string}]}. Include at least src/App.jsx and server/index.js.';

const FILE_OPEN = "<omni-file";
const FILE_CLOSE = "</omni-file>";

// Pull the first complete <omni-file …>…</omni-file> out of a streaming buffer.
function extractFileBlock(buffer: string): { path: string; content: string; rest: string } | null {
  const open = buffer.indexOf(FILE_OPEN);
  if (open === -1) return null;
  const openEnd = buffer.indexOf(">", open + FILE_OPEN.length);
  if (openEnd === -1) return null;
  const close = buffer.indexOf(FILE_CLOSE, openEnd);
  if (close === -1) return null;
  const pathMatch = buffer.slice(open, openEnd).match(/path\s*=\s*["']([^"']+)["']/);
  const content = buffer
    .slice(openEnd + 1, close)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n[ \t]*$/, "");
  return { path: pathMatch ? pathMatch[1] : "", content, rest: buffer.slice(close + FILE_CLOSE.length) };
}

// Stream the tag protocol, surfacing each file the moment it completes.
async function streamGenerate(
  system: string,
  instruction: string,
  onFile?: (f: ProjectFile) => void,
): Promise<ProjectFile[]> {
  const files: ProjectFile[] = [];
  const seen = new Set<string>();
  let buffer = "";
  const drain = () => {
    let block: ReturnType<typeof extractFileBlock>;
    while ((block = extractFileBlock(buffer)) !== null) {
      buffer = block.rest;
      const path = normPath(block.path);
      if (!path || seen.has(path) || IMMUTABLE_PATHS.has(path)) continue;
      seen.add(path);
      const file = { path, content: block.content };
      files.push(file);
      onFile?.(file);
    }
  };
  for await (const delta of streamLLM({
    system,
    prompt: instruction + STREAM_FORMAT,
    model: MODELS.agent,
    maxTokens: 32000,
    timeout: 300_000,
    maxRetries: 1,
  })) {
    buffer += delta;
    if (buffer.includes(FILE_CLOSE)) drain();
  }
  drain();
  return files;
}

/** Generate a runnable, good-looking full-stack project from a prompt. Streams
 *  the file blocks (calling onFile as each completes); falls back to a single
 *  non-streaming JSON generation if the stream fails or omits a required file. */
export async function generateFullstackProject(
  prompt: string,
  onFile?: (f: ProjectFile) => void,
): Promise<GeneratedProject> {
  const brief = await planApp(prompt);
  const system = brief.platform === "mobile" ? `${SYSTEM}\n\n${MOBILE_GUIDE}` : SYSTEM;
  const instruction = buildInstruction(prompt, brief);
  const scaffold = scaffoldFiles(brief.theme, brief.platform);
  const complete = (llmFiles: ProjectFile[]) =>
    llmFiles.some((f) => f.path === "src/App.jsx") && llmFiles.some((f) => f.path === "server/index.js");
  const done = (llmFiles: ProjectFile[]): GeneratedProject => ({
    name: brief.name,
    summary: brief.summary,
    files: assemble(scaffold, llmFiles),
    installCmd: INSTALL_CMD,
    devCmd: DEV_CMD,
    previewPort: PREVIEW_PORT,
  });

  // Primary path: streamed tag protocol — files surface incrementally and
  // content is verbatim (no fragile JSON escaping / truncation-repair).
  try {
    const streamed = await streamGenerate(system, instruction, onFile);
    if (complete(streamed)) return done(streamed);
    logger.info({ files: streamed.length }, "[fullstack] stream produced incomplete app; falling back to JSON");
  } catch (err) {
    logger.info({ err }, "[fullstack] stream codegen failed; falling back to JSON");
  }

  // Fallback: single non-streaming JSON generation.
  const raw = await callLLMJSON<RawGen>({
    system,
    prompt: instruction + JSON_FORMAT,
    model: MODELS.agent,
    maxTokens: 32000,
    timeout: 300_000,
    maxRetries: 1,
  });
  const llmFiles = cleanFiles(raw);
  if (!complete(llmFiles)) {
    const hasApp = llmFiles.some((f) => f.path === "src/App.jsx");
    const hasServer = llmFiles.some((f) => f.path === "server/index.js");
    throw new Error(
      `Codegen incomplete: missing ${!hasApp ? "src/App.jsx" : ""}${!hasApp && !hasServer ? " and " : ""}${!hasServer ? "server/index.js" : ""}.`,
    );
  }
  if (onFile) for (const f of llmFiles) onFile(f);
  return done(llmFiles);
}

const REVISE_SYSTEM = [
  "You are editing an existing full-stack app: a Vite + React 18 + Tailwind frontend (shadcn-style design tokens + primitives in src/components/ui/*) and an Express + better-sqlite3 backend, with Vite proxying /api to the server on port " + API_PORT + ".",
  "Apply the user's change request while preserving the app's quality bar (Linear/Vercel/Stripe-grade) and its existing features.",
  "",
  "RULES:",
  "- Return the COMPLETE new content of ONLY the files you change or add. Do not return files you didn't touch.",
  "- You may change files under src/ or server/ (including src/index.css to adjust the palette). NEVER change package.json, vite.config.js, tailwind.config.js, postcss.config.js, index.html, src/main.jsx, or src/lib/utils.js.",
  "- Keep using ONLY these deps: react, react-dom, react-router-dom, lucide-react, clsx, tailwind-merge, class-variance-authority, express, better-sqlite3. No new packages, no CDNs, no external network calls (except AI via ./ai.js, below).",
  "- Use ONLY semantic Tailwind tokens (never hardcoded colors). The frontend talks to the backend via fetch('/api/...'). Keep it functional and persistent.",
  "",
  AI_GUIDE,
].join("\n");

/** Whole-file rewrite fallback: the model returns full new content for any file
 *  it changes. Reliable but heavy; used only when surgical diffs don't apply. */
async function reviseWholeFile(
  currentFiles: ProjectFile[],
  instruction: string,
): Promise<{ changedFiles: ProjectFile[]; summary: string }> {
  const editable = currentFiles.filter((f) => isEditable(f.path));
  const filesBlock = editable.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n\n");

  const raw = await callLLMJSON<RawGen>({
    system: REVISE_SYSTEM,
    prompt:
      `Current app files:\n\n${filesBlock}\n\n` +
      `Change request: ${instruction}\n\n` +
      'Respond with JSON: {"summary": string (one sentence on what changed), "files": [{"path": string, "content": string}]}. Return only the files you changed or added.',
    model: MODELS.agent,
    maxTokens: 24000,
    timeout: 240_000,
    maxRetries: 1,
  });

  const changedFiles = cleanFiles(raw).filter((f) => isEditable(f.path));
  return { changedFiles, summary: raw.summary?.trim() || instruction.slice(0, 140) };
}

// ── surgical diff edits ──────────────────────────────────────────────────────
// The model returns small find/replace edits instead of whole files, so an edit
// to a 30-file app touches only the changed lines — faster, cheaper, and it
// can't silently regress untouched code. If any `find` fails to match exactly we
// fall back to the whole-file rewrite so the change still lands.
const DIFF_SYSTEM = [
  "You are editing an existing full-stack app (Vite + React 18 + Tailwind with a shadcn-style design system; Express + better-sqlite3 backend; Vite proxies /api to the server on port " + API_PORT + "). Apply the user's change as SURGICAL edits so existing features and code are preserved exactly.",
  "",
  "Return JSON with this exact shape:",
  '  {"summary": string, "edits": [{"path": string, "find": string, "replace": string}], "newFiles": [{"path": string, "content": string}], "deleteFiles": [string]}',
  "",
  "RULES:",
  '- Each edit\'s "find" MUST be an exact, verbatim substring copied from the current file below, with original indentation and enough surrounding context (3+ lines where possible) to be UNIQUE within that file. "replace" is the text that takes its place.',
  "- Make the SMALLEST edits that accomplish the change. Never paste a whole file into find/replace.",
  "- To add a brand-new file, use newFiles (full content). If a file changes almost entirely, put it in newFiles at the same path to overwrite it. To remove a file, list its path in deleteFiles.",
  "- Only touch files under src/ or server/. NEVER edit package.json, vite.config.js, tailwind.config.js, postcss.config.js, index.html, src/main.jsx, src/lib/utils.js, or server/ai.js.",
  "- Preserve the design system: use ONLY semantic Tailwind tokens (never hardcoded colors). Keep the existing deps (react, react-dom, react-router-dom, lucide-react, clsx, tailwind-merge, class-variance-authority, express, better-sqlite3) — no new packages. Real AI stays via ./ai.js. Keep the app functional and persistent (frontend calls fetch('/api/...')).",
  "",
  AI_GUIDE,
].join("\n");

interface RawDiff {
  summary?: string;
  edits?: { path?: string; find?: string; replace?: string }[];
  newFiles?: { path?: string; content?: string }[];
  deleteFiles?: unknown;
}

async function reviseWithDiffs(currentFiles: ProjectFile[], instruction: string): Promise<RawDiff> {
  const editable = currentFiles.filter((f) => isEditable(f.path));
  const filesBlock = editable.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n\n");
  return callLLMJSON<RawDiff>({
    system: DIFF_SYSTEM,
    prompt:
      `Current app files:\n\n${filesBlock}\n\n` +
      `Change request: ${instruction}\n\n` +
      "Respond with the JSON edit object. Prefer small surgical edits; only use newFiles for genuinely new files.",
    model: MODELS.agent,
    maxTokens: 16000,
    timeout: 240_000,
    maxRetries: 1,
  });
}

/** Apply diff edits to the current files. Returns the fully-resolved content of
 *  every touched/new file, the paths to delete, and how many `find`s failed to
 *  match (a signal to fall back to a whole-file rewrite). */
function applyProjectEdits(
  currentFiles: ProjectFile[],
  res: RawDiff,
): { changedFiles: ProjectFile[]; deletedPaths: string[]; matchFailures: number } {
  const byPath = new Map(currentFiles.map((f) => [f.path, f.content]));
  const touched = new Set<string>();
  let matchFailures = 0;

  for (const e of res.edits ?? []) {
    if (typeof e?.path !== "string" || typeof e?.find !== "string" || e.find.length === 0) continue;
    const path = normPath(e.path);
    if (!isEditable(path) || !byPath.has(path)) {
      matchFailures++;
      continue;
    }
    const content = byPath.get(path)!;
    const idx = content.indexOf(e.find);
    if (idx === -1) {
      matchFailures++;
      continue;
    }
    const replace = typeof e.replace === "string" ? e.replace : "";
    byPath.set(path, content.slice(0, idx) + replace + content.slice(idx + e.find.length));
    touched.add(path);
  }

  for (const f of res.newFiles ?? []) {
    if (typeof f?.path !== "string" || typeof f?.content !== "string") continue;
    const path = normPath(f.path);
    if (!isEditable(path)) continue;
    byPath.set(path, f.content);
    touched.add(path);
  }

  const deletedPaths: string[] = [];
  for (const p of Array.isArray(res.deleteFiles) ? res.deleteFiles : []) {
    if (typeof p !== "string") continue;
    const path = normPath(p);
    if (isEditable(path) && byPath.has(path)) {
      byPath.delete(path);
      deletedPaths.push(path);
    }
  }

  const changedFiles = [...touched]
    .filter((p) => byPath.has(p))
    .map((p) => ({ path: p, content: byPath.get(p)! }));
  return { changedFiles, deletedPaths, matchFailures };
}

export interface RevisionResult {
  changedFiles: ProjectFile[];
  deletedPaths: string[];
  summary: string;
}

/** Apply a natural-language change. Tries surgical diff edits first (fast, and
 *  preserves untouched code); falls back to a whole-file rewrite if any find
 *  fails to match or the diff produced no changes. */
export async function reviseFullstackProject(
  currentFiles: ProjectFile[],
  instruction: string,
): Promise<RevisionResult> {
  try {
    const raw = await reviseWithDiffs(currentFiles, instruction);
    const { changedFiles, deletedPaths, matchFailures } = applyProjectEdits(currentFiles, raw);
    if (matchFailures === 0 && (changedFiles.length > 0 || deletedPaths.length > 0)) {
      return { changedFiles, deletedPaths, summary: raw.summary?.trim() || instruction.slice(0, 140) };
    }
    logger.info(
      { matchFailures, changed: changedFiles.length },
      "[fullstack] diff edit incomplete; falling back to whole-file rewrite",
    );
  } catch (err) {
    logger.info({ err }, "[fullstack] diff edit failed; falling back to whole-file rewrite");
  }
  const whole = await reviseWholeFile(currentFiles, instruction);
  return { changedFiles: whole.changedFiles, deletedPaths: [], summary: whole.summary };
}

const REPAIR_SYSTEM = [
  "You are debugging a Vite + React 18 + Tailwind frontend and an Express + better-sqlite3 backend. The project failed its build/syntax check. Fix the root cause so `vite build` and `node --check server/index.js` both pass.",
  "You get the current source files and the error output.",
  "",
  "RULES:",
  "- Return the COMPLETE new content of ONLY the files you must change to fix the errors. Do not return unrelated files.",
  "- Change only files under src/ or server/. Never change package.json, vite.config.js, tailwind.config.js, postcss.config.js, index.html, src/main.jsx, or src/lib/utils.js.",
  "- Do NOT add npm packages. Only these exist: react, react-dom, react-router-dom, lucide-react, clsx, tailwind-merge, class-variance-authority, express, better-sqlite3.",
  "- Fix the ACTUAL cause (missing/incorrect import path, undefined variable, missing export, bad JSX, syntax error, wrong hook usage). Preserve all existing features and the design.",
].join("\n");

/** Fix build/syntax errors in an existing project; returns only changed files. */
export async function repairFullstackProject(
  currentFiles: ProjectFile[],
  errorLog: string,
): Promise<{ changedFiles: ProjectFile[]; summary: string }> {
  const editable = currentFiles.filter((f) => isEditable(f.path));
  const filesBlock = editable.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n\n");

  const raw = await callLLMJSON<RawGen>({
    system: REPAIR_SYSTEM,
    prompt:
      `Current app files:\n\n${filesBlock}\n\n` +
      `Build / syntax error output:\n\n${errorLog.slice(-6000)}\n\n` +
      'Respond with JSON: {"summary": string (what you fixed), "files": [{"path": string, "content": string}]}. Return only the files you changed.',
    model: MODELS.agent,
    maxTokens: 16000,
    timeout: 240_000,
    maxRetries: 1,
  });

  const changedFiles = cleanFiles(raw).filter((f) => isEditable(f.path));
  return { changedFiles, summary: raw.summary?.trim() || "Fixed build errors" };
}
