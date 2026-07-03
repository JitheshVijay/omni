// Thin wrapper around Exa.ai's search + contents APIs. Used by the chat
// pipeline and the agent's web_search tool. Optional: when EXA_API_KEY
// is unset (or any call fails), helpers return [] and the caller falls
// back (e.g. to the :online model variant).

import { env } from "@omni/env-config";
import { logger } from "../logging/logger.js";

export interface ExaSearchResult {
  title: string;
  url: string;
  // First ~500 chars of the page text when Exa returns contents.
  snippet?: string;
  publishedDate?: string;
}

export interface ExaSearchOptions {
  // Max results to return. Defaults to 5. Costs increase past 10.
  numResults?: number;
  // Restrict results to these hostnames.
  includeDomains?: string[];
  // "neural" for embedding-based search, "keyword" for BM25-style, or
  // "auto" (default) to let Exa pick.
  type?: "auto" | "neural" | "keyword";
  // Optional category nudge: "research paper", "company", "news",
  // "github", "pdf", etc.
  category?: string;
  // Only return items published on or after this ISO 8601 date.
  startPublishedDate?: string;
}

// Search Exa and return URL candidates with short text snippets.
// Returns [] when the API key isn't set or the call fails — callers
// should treat empty as "no Exa results" and use their fallback.
export async function searchExa(
  query: string,
  opts: ExaSearchOptions = {},
): Promise<ExaSearchResult[]> {
  if (!env.EXA_API_KEY) return [];
  if (!query || query.length === 0) return [];

  const body: Record<string, unknown> = {
    query,
    numResults: opts.numResults ?? 5,
    type: opts.type ?? "auto",
    // Ask for a short text excerpt per result so callers get a snippet
    // without a second /contents round-trip.
    contents: { text: { maxCharacters: 500 } },
  };
  if (opts.includeDomains && opts.includeDomains.length > 0) {
    body.includeDomains = opts.includeDomains;
  }
  if (opts.category) body.category = opts.category;
  if (opts.startPublishedDate) body.startPublishedDate = opts.startPublishedDate;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.EXA_API_KEY,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      logger.warn({ status: r.status, query }, "[searchExa] non-2xx response");
      return [];
    }
    const data = (await r.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        text?: string;
        publishedDate?: string;
      }>;
    };
    return (data.results ?? [])
      .filter(
        (res): res is { url: string } & typeof res =>
          typeof res.url === "string" && res.url.length > 0,
      )
      .map((res) => ({
        title: res.title ?? res.url,
        url: res.url,
        snippet: res.text ? res.text.slice(0, 500) : undefined,
        publishedDate: res.publishedDate,
      }));
  } catch (err) {
    logger.warn({ err, query }, "[searchExa] threw");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Fetch cleaned page text for a batch of URLs via Exa's /contents
// endpoint ($1/1k pages; up to 100 URLs per request, though callers
// here pass "top N from a search"). Returns [] when EXA_API_KEY isn't
// set or the call fails.

export interface ExaContent {
  url: string;
  text: string;
  title?: string;
}

export interface ExaContentsOptions {
  // Per-URL character cap on returned text. Defaults to 4000 — enough
  // to ground an answer without blowing the caller's context. Exa
  // truncates cleanly on word boundaries.
  maxCharactersPerUrl?: number;
}

export async function getExaContents(
  urls: string[],
  opts: ExaContentsOptions = {},
): Promise<ExaContent[]> {
  if (!env.EXA_API_KEY) return [];
  if (urls.length === 0) return [];

  const body = {
    urls,
    text: { maxCharacters: opts.maxCharactersPerUrl ?? 4000 },
  };

  const ctrl = new AbortController();
  // 15s timeout — /contents crawls each URL and cleans the markup, so
  // it's much slower than /search.
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const r = await fetch("https://api.exa.ai/contents", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.EXA_API_KEY,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      logger.warn(
        { status: r.status, urlCount: urls.length },
        "[getExaContents] non-2xx response",
      );
      return [];
    }
    const data = (await r.json()) as {
      results?: Array<{
        url?: string;
        text?: string;
        title?: string;
      }>;
    };
    return (data.results ?? [])
      .filter(
        (res): res is { url: string; text: string } & typeof res =>
          typeof res.url === "string" &&
          typeof res.text === "string" &&
          res.text.length > 0,
      )
      .map((res) => ({
        url: res.url,
        text: res.text,
        title: res.title,
      }));
  } catch (err) {
    logger.warn({ err, urlCount: urls.length }, "[getExaContents] threw");
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Find pages semantically similar to a given URL via Exa's /findSimilar
// endpoint. Returns [] on no-key / failure.

export interface FindSimilarOptions {
  // Max results to return. Defaults to 5.
  numResults?: number;
  // When true, exclude results from the same host as the seed URL —
  // "give me OTHER perspectives" semantics.
  excludeSourceDomain?: boolean;
}

export async function findSimilarExa(
  url: string,
  opts: FindSimilarOptions = {},
): Promise<ExaSearchResult[]> {
  if (!env.EXA_API_KEY) return [];
  if (!url || !/^https?:\/\//i.test(url)) return [];

  const body: Record<string, unknown> = {
    url,
    numResults: opts.numResults ?? 5,
  };
  if (opts.excludeSourceDomain) body.excludeSourceDomain = true;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8_000);
  try {
    const r = await fetch("https://api.exa.ai/findSimilar", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.EXA_API_KEY,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!r.ok) {
      logger.warn(
        { status: r.status, url },
        "[findSimilarExa] non-2xx response",
      );
      return [];
    }
    const data = (await r.json()) as {
      results?: Array<{
        title?: string;
        url?: string;
        publishedDate?: string;
      }>;
    };
    return (data.results ?? [])
      .filter(
        (res): res is { url: string } & typeof res =>
          typeof res.url === "string" && res.url.length > 0,
      )
      .map((res) => ({
        title: res.title ?? res.url,
        url: res.url,
        publishedDate: res.publishedDate,
      }));
  } catch (err) {
    logger.warn({ err, url }, "[findSimilarExa] threw");
    return [];
  } finally {
    clearTimeout(timer);
  }
}
