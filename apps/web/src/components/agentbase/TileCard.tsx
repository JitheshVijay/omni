// A single dashboard tile, rendered from a server-computed Tile. Three kinds:
//   stat  : one big number (the tile's `value`)
//   bar   : horizontal grouped bars from `points`, each directly labeled
//   donut : an inline-SVG donut from `points` with a legend list
//
// Charts are inline SVG / styled divs; no chart library. Grouped buckets use a
// fixed-order categorical palette (validated dark categorical set from the
// dataviz skill; CVD sits in the 8–12 floor band, so every mark is DIRECTLY
// LABELLED as the required secondary encoding; identity is never colour-alone).
// Numbers use tabular figures so they align.

import type { Tile, TilePoint } from "@/lib/agentbase";
import { formatStat } from "@/lib/agentbase";

// Fixed-order categorical hues, stepped for a dark surface. Assigned by bucket
// order and never cycled; a 9th bucket folds into a muted "Other"-style tone.
const SERIES = [
  "#3987e5",
  "#199e70",
  "#c98500",
  "#008300",
  "#9085e9",
  "#e66767",
  "#d55181",
  "#d95926",
] as const;
const OVERFLOW = "#5b5b66";

function seriesColor(i: number): string {
  return i < SERIES.length ? SERIES[i] : OVERFLOW;
}

export function TileCard({ tile }: { tile: Tile }) {
  return (
    <div className="flex flex-col rounded-2xl border border-line bg-surface2 p-4 shadow-sm">
      <h3 className="mb-3 line-clamp-1 text-xs font-medium uppercase tracking-wider text-muted">
        {tile.title}
      </h3>
      {tile.kind === "stat" ? (
        <StatBody tile={tile} />
      ) : tile.kind === "bar" ? (
        <BarBody points={tile.points} />
      ) : (
        <DonutBody points={tile.points} />
      )}
    </div>
  );
}

function StatBody({ tile }: { tile: Tile }) {
  const suffix =
    tile.config.agg === "avg" ? "avg" : tile.config.agg === "sum" ? "total" : "";
  return (
    <div className="flex flex-1 flex-col justify-center">
      <div
        className="font-display text-4xl font-semibold tracking-tight text-ink"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {formatStat(tile.value)}
      </div>
      {suffix && <div className="mt-1 text-[11px] text-muted">{suffix}</div>}
    </div>
  );
}

function BarBody({ points }: { points: TilePoint[] }) {
  if (points.length === 0) return <EmptyChart />;
  const max = Math.max(...points.map((p) => p.value), 1);
  return (
    <div className="flex flex-col gap-2.5">
      {points.slice(0, 6).map((p, i) => {
        const pct = Math.max((p.value / max) * 100, 2);
        return (
          <div key={p.label + i} className="flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="truncate text-muted" title={p.label}>
                {p.label}
              </span>
              <span
                className="shrink-0 font-medium text-ink"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {formatStat(p.value)}
              </span>
            </div>
            {/* Track + fill; 4px rounded data-end anchored to the baseline. */}
            <div className="h-2 w-full overflow-hidden rounded-full bg-surface3">
              <div
                className="h-full rounded-full"
                style={{ width: `${pct}%`, backgroundColor: seriesColor(i) }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DonutBody({ points }: { points: TilePoint[] }) {
  const shown = points.slice(0, 6);
  const total = shown.reduce((acc, p) => acc + p.value, 0);
  if (shown.length === 0 || total <= 0) return <EmptyChart />;

  // Build stroke-dasharray arcs around a 44px-radius ring. A 2px surface gap
  // between segments keeps adjacent fills from bleeding together.
  const R = 44;
  const C = 2 * Math.PI * R;
  const GAP = 3; // px of circumference left as a surface-coloured gap
  let offset = 0;
  const arcs = shown.map((p, i) => {
    const frac = p.value / total;
    const len = Math.max(frac * C - GAP, 0);
    const arc = { color: seriesColor(i), dash: len, gap: C - len, offset };
    offset -= frac * C;
    return arc;
  });

  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 120 120" className="size-24 shrink-0 -rotate-90">
        <circle cx="60" cy="60" r={R} fill="none" stroke="rgb(var(--color-surface3))" strokeWidth="14" />
        {arcs.map((a, i) => (
          <circle
            key={i}
            cx="60"
            cy="60"
            r={R}
            fill="none"
            stroke={a.color}
            strokeWidth="14"
            strokeDasharray={`${a.dash} ${a.gap}`}
            strokeDashoffset={a.offset}
          />
        ))}
      </svg>
      {/* Legend: identity by label, so never colour-alone. */}
      <ul className="flex min-w-0 flex-1 flex-col gap-1.5">
        {shown.map((p, i) => (
          <li key={p.label + i} className="flex items-center gap-2 text-xs">
            <span
              className="size-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: seriesColor(i) }}
            />
            <span className="truncate text-muted" title={p.label}>
              {p.label}
            </span>
            <span
              className="ml-auto shrink-0 font-medium text-ink"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {formatStat(p.value)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmptyChart() {
  return (
    <div className="flex flex-1 items-center justify-center py-6 text-xs text-muted">
      No data yet
    </div>
  );
}
