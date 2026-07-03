// Wraps React.lazy() so that a failed dynamic-chunk import triggers a
// one-time auto-reload. Solves the canonical SPA-after-deploy failure mode:
//
//   1. Browser caches index.html referencing chunks at hashes [A1, A2, A3].
//   2. A new build ships. Chunks now have hashes [B1, B2, B3]; the old
//      hashes are gone.
//   3. A client-side navigation to a not-yet-visited route tries to import
//      a stale chunk → 404/MIME mismatch → the route blanks out.
//
// The fix: detect the failure and reload — the reload fetches the FRESH
// index.html, and the next navigation works. A sessionStorage guard
// prevents an infinite reload loop if a chunk is genuinely missing.
//
// Use exactly like React.lazy:
//   const Page = lazyWithReload(() => import("./Page"));

import { lazy, type ComponentType, type LazyExoticComponent } from "react";

const RELOAD_FLAG_KEY = "omni.chunk-reload-attempted";
// If we've reloaded within this window, assume the chunk is genuinely broken
// and re-throw rather than loop.
const RELOAD_FLAG_TTL_MS = 60_000;

function shouldAttemptReload(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /Failed to fetch dynamically imported module|Loading chunk|Importing a module script failed|MIME type/i.test(
    err.message,
  );
}

function reloadAttemptIsFresh(): boolean {
  try {
    const raw = sessionStorage.getItem(RELOAD_FLAG_KEY);
    if (!raw) return false;
    const ts = Number(raw);
    return Number.isFinite(ts) && Date.now() - ts < RELOAD_FLAG_TTL_MS;
  } catch {
    return false;
  }
}

function markReloadAttempted(): void {
  try {
    sessionStorage.setItem(RELOAD_FLAG_KEY, String(Date.now()));
  } catch {
    // Storage may be unavailable in private mode. Without persistence we
    // can't dedupe — risk one extra reload rather than blank-and-give-up.
  }
}

export function lazyWithReload<T extends ComponentType<unknown>>(
  importFn: () => Promise<{ default: T }>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      return await importFn();
    } catch (err) {
      if (shouldAttemptReload(err) && !reloadAttemptIsFresh()) {
        markReloadAttempted();
        // Hard navigation so caches that ignore SPA-router state get a fresh
        // document request. The never-resolving promise keeps the lazy
        // boundary in its loading state until the reload completes.
        window.location.reload();
        return new Promise<{ default: T }>(() => {});
      }
      throw err;
    }
  });
}
