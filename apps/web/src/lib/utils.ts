import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

// Standard shadcn-style class merger: combine clsx (conditional classes)
// with tailwind-merge (deduplicate Tailwind utilities so the last write wins).
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Compact relative timestamp for list rows ("just now", "5m", "3h", "2d",
// then a short date). Input is an ISO-8601 string from the API.
export function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// Human-readable byte size ("1.2 MB").
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// "anthropic/claude-sonnet-5" -> "claude-sonnet-5"; keeps unknown ids legible.
export function prettyModel(id: string | null | undefined): string {
  if (!id) return "";
  const tail = id.split("/").pop() ?? id;
  return tail.replace(/:online$/, " (online)");
}

// "$0.0042" — trims to a sensible precision for per-message costs.
export function formatCost(usd: number | null | undefined): string {
  if (usd == null || !Number.isFinite(usd)) return "";
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

// SQLite JSON columns may arrive as parsed objects or raw strings depending
// on the route; normalize defensively.
export function parseMaybeJson<T>(v: T | string | null | undefined): T | null {
  if (v == null) return null;
  if (typeof v === "string") {
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  return v;
}
