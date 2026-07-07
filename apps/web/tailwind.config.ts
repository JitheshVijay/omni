import type { Config } from "tailwindcss";

// CSS-variable-backed tokens (RGB triplets in globals.css) so Tailwind opacity
// modifiers work: bg-surface/50 etc. Mirrors the Flo101 token approach.
const config: Config = {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: "rgb(var(--color-surface) / <alpha-value>)",
        surface2: "rgb(var(--color-surface2) / <alpha-value>)",
        surface3: "rgb(var(--color-surface3) / <alpha-value>)",
        ink: "rgb(var(--color-ink) / <alpha-value>)",
        muted: "rgb(var(--color-muted) / <alpha-value>)",
        accent: "rgb(var(--color-accent) / <alpha-value>)",
        accent2: "rgb(var(--color-accent2) / <alpha-value>)",
        line: "rgb(var(--color-line) / <alpha-value>)",
        // Brand + dark surfaces — stable across light/dark themes.
        canvasDark: "rgb(var(--canvas-dark) / <alpha-value>)",
        darkSoft: "rgb(var(--dark-soft) / <alpha-value>)",
        darkLine: "rgb(var(--dark-line) / <alpha-value>)",
        brandOrange: "rgb(var(--brand-orange) / <alpha-value>)",
        brandMagenta: "rgb(var(--brand-magenta) / <alpha-value>)",
        brandPeriwinkle: "rgb(var(--brand-periwinkle) / <alpha-value>)",
        brandMint: "rgb(var(--brand-mint) / <alpha-value>)",
      },
      fontFamily: {
        // Two faces carry the whole system: Inter for display + body, JetBrains
        // Mono for uppercase eyebrows / button labels / table headers.
        sans: ["Inter", "system-ui", "sans-serif"],
        display: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      // Crisp, technical radii — 4px is canonical; only the chat orb is full.
      borderRadius: {
        none: "0px",
        sm: "3px",
        DEFAULT: "4px",
        md: "5px",
        lg: "6px",
        xl: "8px",
        "2xl": "10px",
        "3xl": "12px",
        full: "9999px",
      },
    },
  },
  plugins: [],
};

export default config;
