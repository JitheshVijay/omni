// Thin SWR wrapper that auto-attaches the auth Bearer token, unwraps the
// Omni response envelope ({success:true, data}) and parses errors via the
// shared parseApiError shape. Adapted from Flo101's use-api.ts with the
// AuthContext swapped for the local-auth stub.
//
// Repeat navigations to a previously-visited page serve from SWR's cache
// instantly while revalidating in the background (30s dedupe window is set
// globally in AppProviders).

import { useCallback } from "react";
import useSWR, {
  type SWRConfiguration,
  type SWRResponse,
  mutate as globalMutate,
} from "swr";
import { useAuth, getLocalAccessToken } from "@/lib/local-auth";
import { parseApiError, type ParsedApiError } from "@/lib/api-error";

export const API_BASE: string =
  (import.meta.env.VITE_API_URL as string | undefined) || "http://localhost:4100";

// Unwrap the `{success:true, data}` envelope; tolerate bare payloads so a
// non-enveloped endpoint (or a proxy) doesn't explode the whole page.
function unwrapEnvelope<T>(json: unknown): T {
  if (json && typeof json === "object" && "data" in (json as Record<string, unknown>)) {
    return (json as { data: T }).data;
  }
  return json as T;
}

export interface UseApiOptions<T> extends SWRConfiguration<T> {
  // When false, prevents SWR from firing the fetch (e.g. when waiting on a
  // route param). Mirrors the standard SWR pattern of passing `null` as the
  // key to disable.
  enabled?: boolean;
}

export type UseApiResult<T> = SWRResponse<T, ParsedApiError> & {
  // True while the FIRST load is in flight (no cached data yet). Distinct
  // from `isValidating`, which is true on every revalidation.
  isInitialLoading: boolean;
};

// Path can be absolute (`https://...`) but we join API_BASE for app paths.
function resolveUrl(path: string): string {
  if (path.startsWith("http://") || path.startsWith("https://")) return path;
  return `${API_BASE}${path}`;
}

export function useApi<T = unknown>(
  path: string | null,
  options?: UseApiOptions<T>,
): UseApiResult<T> {
  const { user, getAccessToken } = useAuth();
  const enabled = options?.enabled ?? true;
  // SWR convention: null key disables the fetch entirely.
  const key = enabled && path ? resolveUrl(path) : null;

  const fetcher = useCallback(
    async (url: string): Promise<T> => {
      const token = user ? await getAccessToken() : null;
      const r = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!r.ok) {
        // Surface the structured shape so callers can branch on status/code.
        // SWR exposes the thrown value as `error`.
        throw await parseApiError(r);
      }
      return unwrapEnvelope<T>(await r.json());
    },
    [user, getAccessToken],
  );

  const swr = useSWR<T, ParsedApiError>(key, fetcher, options);

  return {
    ...swr,
    isInitialLoading: swr.isLoading && swr.data === undefined,
  };
}

// Invalidate a cached endpoint from outside the React tree (e.g. after a
// POST/PATCH that should bust the cache for a related GET). The returned
// promise resolves AFTER revalidation completes — callers can await it to
// sequence UI state changes against fresh data.
export function invalidateApi(path: string): Promise<unknown> {
  return globalMutate(resolveUrl(path));
}

// Match-by-prefix mutate for invalidating a family of keys (e.g. all
// `/api/chat/threads*` keys after a thread is created/deleted/retitled).
export function invalidateApiPrefix(prefix: string): Promise<unknown> {
  const fullPrefix = resolveUrl(prefix);
  return globalMutate(
    (key) => typeof key === "string" && key.startsWith(fullPrefix),
    undefined,
    { revalidate: true },
  );
}

// Mutation helper: attaches the Bearer token, defaults Content-Type to JSON
// for string bodies (leaves FormData alone so the browser sets the multipart
// boundary), throws ParsedApiError on !ok, and returns the unwrapped
// envelope `data`.
export async function authFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const r = await authFetchRaw(path, init);
  if (!r.ok) throw await parseApiError(r);
  const json = (await r.json().catch(() => null)) as unknown;
  return unwrapEnvelope<T>(json);
}

// Raw variant for callers that need the Response itself (blob downloads,
// SSE handshakes). Does NOT throw on !ok — the caller decides.
export async function authFetchRaw(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const token = await getLocalAccessToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
  if (init.body != null && !isFormData && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(resolveUrl(path), { ...init, headers });
}
