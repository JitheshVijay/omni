// Renders ONE SlideSpec on the fixed 1280x720 design canvas. Colours + fonts
// come entirely from the deck's embedded Theme (inline styles, since the
// tokens are arbitrary hex from JSON); layout is plain flex geometry in
// absolute px. The parent (DeckViewer / print page / thumbnail) scales the
// whole canvas with a CSS transform; this component never scales itself.
//
// Charts are drawn as inline SVG (recharts is not a web dependency). Single
// series → no legend box, direct value labels, thin marks with rounded ends,
// recessive axis; pie uses tints of the theme accent with a labelled legend
// so identity is never colour-alone.

import { useState } from "react";
import { API_BASE } from "@/lib/use-api";
import {
  SLIDE_H,
  SLIDE_W,
  type ChartData,
  type Column,
  type ImageTextSlide,
  type SlideSpec,
  type Theme,
} from "@/lib/slide-types";

const PAD = 88;

function fontStack(family: string): string {
  return `"${family}", "Inter", system-ui, -apple-system, sans-serif`;
}

// ─── Colour helpers (pie tints) ─────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full || "000000", 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hexToRgb(a);
  const [br, bg, bb] = hexToRgb(b);
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return `#${[r, g, bl].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// A magnitude ramp from accent2 (light) toward accent (deep), evenly spread.
function tintRamp(theme: Theme, n: number): string[] {
  if (n <= 1) return [theme.accent];
  return Array.from({ length: n }, (_, i) => mix(theme.accent2, theme.accent, i / (n - 1)));
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (Math.abs(v) >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return String(Math.round(v * 100) / 100);
}

// ─── Frame ──────────────────────────────────────────────────────────

function frameStyle(theme: Theme): React.CSSProperties {
  return {
    position: "relative",
    width: SLIDE_W,
    height: SLIDE_H,
    overflow: "hidden",
    background: `linear-gradient(135deg, ${theme.bgFrom} 0%, ${theme.bgTo} 100%)`,
    color: theme.text,
    fontFamily: fontStack(theme.fontBody),
  };
}

/** Decorative accent glow in the far corner, a subtle brand texture. */
function AccentGlow({ theme }: { theme: Theme }) {
  return (
    <div
      style={{
        position: "absolute",
        right: -160,
        top: -160,
        width: 520,
        height: 520,
        borderRadius: "50%",
        background: `radial-gradient(circle, ${theme.accent}33 0%, transparent 70%)`,
        pointerEvents: "none",
      }}
    />
  );
}

export function SlideRenderer({ slide, theme }: { slide: SlideSpec; theme: Theme }) {
  return (
    <div style={frameStyle(theme)}>
      <AccentGlow theme={theme} />
      {slide.archetype === "title" && <TitleSlideView slide={slide} theme={theme} />}
      {slide.archetype === "section" && <SectionSlideView slide={slide} theme={theme} />}
      {slide.archetype === "bullets" && <BulletsSlideView slide={slide} theme={theme} />}
      {slide.archetype === "two-col" && <TwoColSlideView slide={slide} theme={theme} />}
      {slide.archetype === "image+text" && <ImageTextSlideView slide={slide} theme={theme} />}
      {slide.archetype === "quote" && <QuoteSlideView slide={slide} theme={theme} />}
      {slide.archetype === "chart" && <ChartSlideView slide={slide} theme={theme} />}
    </div>
  );
}

// ─── Shared bits ────────────────────────────────────────────────────

function SlideHeading({
  title,
  theme,
  subtitle,
}: {
  title: string;
  theme: Theme;
  subtitle?: string;
}) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 16,
        }}
      >
        <span style={{ width: 40, height: 5, borderRadius: 3, background: theme.accent }} />
        <h2
          style={{
            fontFamily: fontStack(theme.fontHeading),
            fontSize: 44,
            lineHeight: 1.1,
            fontWeight: 700,
            margin: 0,
            color: theme.text,
          }}
        >
          {title}
        </h2>
      </div>
      {subtitle && (
        <p style={{ margin: "12px 0 0 56px", fontSize: 22, color: theme.textMuted }}>
          {subtitle}
        </p>
      )}
    </div>
  );
}

function contentStyle(): React.CSSProperties {
  return {
    position: "relative",
    height: "100%",
    padding: PAD,
    display: "flex",
    flexDirection: "column",
    boxSizing: "border-box",
  };
}

// ─── Title ──────────────────────────────────────────────────────────

function TitleSlideView({
  slide,
  theme,
}: {
  slide: Extract<SlideSpec, { archetype: "title" }>;
  theme: Theme;
}) {
  return (
    <div style={{ ...contentStyle(), justifyContent: "center", padding: PAD + 24 }}>
      {slide.eyebrow && (
        <span
          style={{
            fontSize: 18,
            fontWeight: 600,
            letterSpacing: 3,
            textTransform: "uppercase",
            color: theme.accent,
            marginBottom: 20,
          }}
        >
          {slide.eyebrow}
        </span>
      )}
      <h1
        style={{
          fontFamily: fontStack(theme.fontHeading),
          fontSize: 84,
          lineHeight: 1.03,
          fontWeight: 800,
          letterSpacing: -1,
          margin: 0,
          maxWidth: 980,
          color: theme.text,
        }}
      >
        {slide.title}
      </h1>
      {slide.subtitle && (
        <p
          style={{
            marginTop: 28,
            fontSize: 28,
            lineHeight: 1.4,
            color: theme.textMuted,
            maxWidth: 820,
          }}
        >
          {slide.subtitle}
        </p>
      )}
      <div
        style={{
          marginTop: 40,
          width: 120,
          height: 6,
          borderRadius: 3,
          background: `linear-gradient(90deg, ${theme.accent}, ${theme.accent2})`,
        }}
      />
    </div>
  );
}

// ─── Section divider ────────────────────────────────────────────────

function SectionSlideView({
  slide,
  theme,
}: {
  slide: Extract<SlideSpec, { archetype: "section" }>;
  theme: Theme;
}) {
  return (
    <div
      style={{
        ...contentStyle(),
        justifyContent: "center",
        alignItems: "flex-start",
      }}
    >
      <span
        style={{
          fontSize: 20,
          fontWeight: 700,
          letterSpacing: 4,
          textTransform: "uppercase",
          color: theme.accent,
          marginBottom: 24,
        }}
      >
        Section
      </span>
      <h1
        style={{
          fontFamily: fontStack(theme.fontHeading),
          fontSize: 68,
          lineHeight: 1.05,
          fontWeight: 800,
          margin: 0,
          maxWidth: 1000,
          color: theme.text,
        }}
      >
        {slide.title}
      </h1>
      {slide.subtitle && (
        <p style={{ marginTop: 22, fontSize: 26, color: theme.textMuted, maxWidth: 860 }}>
          {slide.subtitle}
        </p>
      )}
    </div>
  );
}

// ─── Bullets ────────────────────────────────────────────────────────

function BulletsSlideView({
  slide,
  theme,
}: {
  slide: Extract<SlideSpec, { archetype: "bullets" }>;
  theme: Theme;
}) {
  const dense = slide.bullets.length > 4;
  return (
    <div style={contentStyle()}>
      <SlideHeading title={slide.title} theme={theme} subtitle={slide.subtitle} />
      <ul
        style={{
          listStyle: "none",
          margin: "8px 0 0 0",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: dense ? 16 : 22,
          flex: 1,
          justifyContent: "center",
        }}
      >
        {slide.bullets.map((b, i) => (
          <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 18 }}>
            <span
              style={{
                marginTop: 10,
                width: 12,
                height: 12,
                borderRadius: 4,
                flexShrink: 0,
                background: `linear-gradient(135deg, ${theme.accent}, ${theme.accent2})`,
              }}
            />
            <span
              style={{
                fontSize: dense ? 26 : 30,
                lineHeight: 1.35,
                color: theme.text,
              }}
            >
              {b}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ─── Two columns ────────────────────────────────────────────────────

function ColumnCard({ col, theme }: { col: Column; theme: Theme }) {
  return (
    <div
      style={{
        flex: 1,
        background: theme.surface,
        border: `1px solid ${theme.border}`,
        borderRadius: 20,
        padding: 32,
        display: "flex",
        flexDirection: "column",
        gap: 18,
      }}
    >
      {col.heading && (
        <h3
          style={{
            fontFamily: fontStack(theme.fontHeading),
            fontSize: 28,
            fontWeight: 700,
            margin: 0,
            color: theme.accent,
          }}
        >
          {col.heading}
        </h3>
      )}
      <ul
        style={{
          listStyle: "none",
          margin: 0,
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        {col.points.map((p, i) => (
          <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
            <span
              style={{
                marginTop: 9,
                width: 8,
                height: 8,
                borderRadius: "50%",
                flexShrink: 0,
                background: theme.accent2,
              }}
            />
            <span style={{ fontSize: 22, lineHeight: 1.35, color: theme.text }}>{p}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function TwoColSlideView({
  slide,
  theme,
}: {
  slide: Extract<SlideSpec, { archetype: "two-col" }>;
  theme: Theme;
}) {
  return (
    <div style={contentStyle()}>
      <SlideHeading title={slide.title} theme={theme} />
      <div style={{ display: "flex", gap: 28, flex: 1, alignItems: "stretch" }}>
        <ColumnCard col={slide.left} theme={theme} />
        <ColumnCard col={slide.right} theme={theme} />
      </div>
    </div>
  );
}

// ─── Image + text ───────────────────────────────────────────────────

function SlideImage({
  slide,
  theme,
}: {
  slide: ImageTextSlide;
  theme: Theme;
}) {
  const [failed, setFailed] = useState(false);
  const showImage = slide.image_artifact_id && !failed;
  return (
    <div
      style={{
        flex: "0 0 46%",
        position: "relative",
        borderRadius: 20,
        overflow: "hidden",
        background: `linear-gradient(160deg, ${theme.accent}55, ${theme.accent2}33)`,
        border: `1px solid ${theme.border}`,
      }}
    >
      {showImage ? (
        <img
          src={`${API_BASE}/api/artifacts/${slide.image_artifact_id}/blob`}
          alt={slide.caption ?? slide.title}
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
        />
      ) : (
        <div
          style={{
            width: "100%",
            height: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 32,
            textAlign: "center",
            color: theme.textMuted,
            fontSize: 18,
          }}
        >
          {slide.image_prompt}
        </div>
      )}
      {slide.caption && showImage && (
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            padding: "22px 20px 14px",
            background: "linear-gradient(to top, rgba(0,0,0,0.55), transparent)",
            color: "#fff",
            fontSize: 16,
          }}
        >
          {slide.caption}
        </div>
      )}
    </div>
  );
}

function ImageTextSlideView({
  slide,
  theme,
}: {
  slide: ImageTextSlide;
  theme: Theme;
}) {
  const image = <SlideImage slide={slide} theme={theme} />;
  const text = (
    <div style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center" }}>
      <SlideHeading title={slide.title} theme={theme} />
      <ul
        style={{
          listStyle: "none",
          margin: "4px 0 0 0",
          padding: 0,
          display: "flex",
          flexDirection: "column",
          gap: 18,
        }}
      >
        {slide.body.map((b, i) => (
          <li key={i} style={{ display: "flex", alignItems: "flex-start", gap: 14 }}>
            <span
              style={{
                marginTop: 10,
                width: 10,
                height: 10,
                borderRadius: 3,
                flexShrink: 0,
                background: theme.accent,
              }}
            />
            <span style={{ fontSize: 24, lineHeight: 1.35, color: theme.text }}>{b}</span>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <div style={{ ...contentStyle(), flexDirection: "row", gap: 44, alignItems: "stretch" }}>
      {slide.image_side === "left" ? (
        <>
          {image}
          {text}
        </>
      ) : (
        <>
          {text}
          {image}
        </>
      )}
    </div>
  );
}

// ─── Quote ──────────────────────────────────────────────────────────

function QuoteSlideView({
  slide,
  theme,
}: {
  slide: Extract<SlideSpec, { archetype: "quote" }>;
  theme: Theme;
}) {
  return (
    <div
      style={{
        ...contentStyle(),
        justifyContent: "center",
        alignItems: "center",
        textAlign: "center",
        padding: PAD + 40,
      }}
    >
      <div
        style={{
          fontFamily: fontStack(theme.fontHeading),
          fontSize: 160,
          lineHeight: 0.7,
          color: theme.accent,
          opacity: 0.5,
          marginBottom: 8,
          height: 90,
        }}
      >
        &ldquo;
      </div>
      <blockquote
        style={{
          margin: 0,
          fontFamily: fontStack(theme.fontHeading),
          fontSize: 46,
          lineHeight: 1.25,
          fontWeight: 600,
          color: theme.text,
          maxWidth: 980,
        }}
      >
        {slide.quote}
      </blockquote>
      {slide.attribution && (
        <div
          style={{
            marginTop: 32,
            fontSize: 22,
            color: theme.textMuted,
            display: "flex",
            alignItems: "center",
            gap: 12,
          }}
        >
          <span style={{ width: 28, height: 2, background: theme.accent }} />
          {slide.attribution}
        </div>
      )}
    </div>
  );
}

// ─── Chart ──────────────────────────────────────────────────────────

function ChartSlideView({
  slide,
  theme,
}: {
  slide: Extract<SlideSpec, { archetype: "chart" }>;
  theme: Theme;
}) {
  return (
    <div style={contentStyle()}>
      <SlideHeading
        title={slide.title}
        theme={theme}
        subtitle={slide.chart.series_label}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <SlideChart data={slide.chart} theme={theme} />
      </div>
      {slide.chart.caption && (
        <p style={{ margin: "12px 0 0 56px", fontSize: 18, color: theme.textMuted }}>
          {slide.chart.caption}
        </p>
      )}
    </div>
  );
}

const CHART_W = SLIDE_W - PAD * 2;
const CHART_H = 400;

function SlideChart({ data, theme }: { data: ChartData; theme: Theme }) {
  if (data.type === "pie") return <PieChart data={data} theme={theme} />;
  if (data.type === "line") return <LineChart data={data} theme={theme} />;
  return <BarChart data={data} theme={theme} />;
}

function axisMax(values: number[]): number {
  const max = Math.max(0, ...values);
  if (max <= 0) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(max)));
  return Math.ceil(max / pow) * pow;
}

function BarChart({ data, theme }: { data: ChartData; theme: Theme }) {
  const { categories, values, unit } = data;
  const plotTop = 40;
  const plotBottom = CHART_H - 56;
  const plotH = plotBottom - plotTop;
  const max = axisMax(values);
  const n = categories.length;
  const slot = CHART_W / n;
  const barW = Math.min(120, slot * 0.5);
  return (
    <svg width="100%" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img">
      {/* baseline */}
      <line x1={0} y1={plotBottom} x2={CHART_W} y2={plotBottom} stroke={theme.border} strokeWidth={2} />
      {values.map((v, i) => {
        const h = Math.max(2, (v / max) * plotH);
        const x = slot * i + slot / 2;
        const y = plotBottom - h;
        return (
          <g key={i}>
            <rect
              x={x - barW / 2}
              y={y}
              width={barW}
              height={h}
              rx={6}
              fill={theme.accent}
            />
            <text
              x={x}
              y={y - 12}
              textAnchor="middle"
              fontSize={22}
              fontWeight={700}
              fill={theme.text}
            >
              {fmtNum(v)}
              {unit ?? ""}
            </text>
            <text
              x={x}
              y={plotBottom + 30}
              textAnchor="middle"
              fontSize={19}
              fill={theme.textMuted}
            >
              {categories[i]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function LineChart({ data, theme }: { data: ChartData; theme: Theme }) {
  const { categories, values, unit } = data;
  const plotTop = 44;
  const plotBottom = CHART_H - 56;
  const plotH = plotBottom - plotTop;
  const padX = 60;
  const innerW = CHART_W - padX * 2;
  const max = axisMax(values);
  const n = values.length;
  const px = (i: number) => padX + (n === 1 ? innerW / 2 : (innerW / (n - 1)) * i);
  const py = (v: number) => plotBottom - (v / max) * plotH;
  const points = values.map((v, i) => `${px(i)},${py(v)}`).join(" ");
  const area = `${padX},${plotBottom} ${points} ${px(n - 1)},${plotBottom}`;
  return (
    <svg width="100%" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img">
      <line x1={0} y1={plotBottom} x2={CHART_W} y2={plotBottom} stroke={theme.border} strokeWidth={2} />
      <polygon points={area} fill={theme.accent} opacity={0.12} />
      <polyline points={points} fill="none" stroke={theme.accent} strokeWidth={3} strokeLinejoin="round" strokeLinecap="round" />
      {values.map((v, i) => (
        <g key={i}>
          <circle cx={px(i)} cy={py(v)} r={7} fill={theme.accent} stroke={theme.bg} strokeWidth={2} />
          <text x={px(i)} y={py(v) - 16} textAnchor="middle" fontSize={20} fontWeight={700} fill={theme.text}>
            {fmtNum(v)}
            {unit ?? ""}
          </text>
          <text x={px(i)} y={plotBottom + 30} textAnchor="middle" fontSize={19} fill={theme.textMuted}>
            {categories[i]}
          </text>
        </g>
      ))}
    </svg>
  );
}

function PieChart({ data, theme }: { data: ChartData; theme: Theme }) {
  const { categories, values, unit } = data;
  const total = values.reduce((s, v) => s + Math.max(0, v), 0) || 1;
  const colors = tintRamp(theme, values.length);
  const cx = 200;
  const cy = CHART_H / 2;
  const r = 155;
  let angle = -Math.PI / 2;
  const arcs = values.map((v, i) => {
    const frac = Math.max(0, v) / total;
    const start = angle;
    const end = angle + frac * Math.PI * 2;
    angle = end;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    const large = end - start > Math.PI ? 1 : 0;
    const d = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
    return { d, color: colors[i], frac };
  });
  return (
    <svg width="100%" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img">
      {arcs.map((a, i) => (
        <path key={i} d={a.d} fill={a.color} stroke={theme.bg} strokeWidth={3} />
      ))}
      {/* labelled legend, so identity is never colour-alone */}
      <g transform={`translate(${cx + r + 90}, ${cy - values.length * 21})`}>
        {categories.map((c, i) => (
          <g key={i} transform={`translate(0, ${i * 42})`}>
            <rect width={22} height={22} rx={5} fill={colors[i]} />
            <text x={34} y={17} fontSize={22} fill={theme.text}>
              {c}
            </text>
            <text x={420} y={17} fontSize={22} fontWeight={700} fill={theme.text} textAnchor="end">
              {fmtNum(values[i])}
              {unit ?? ""} · {Math.round(arcs[i].frac * 100)}%
            </text>
          </g>
        ))}
      </g>
    </svg>
  );
}
