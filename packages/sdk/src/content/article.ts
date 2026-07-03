// Clean article extraction from any URL using Mozilla Readability — the
// algorithm behind Firefox Reader View — over a bounded, SSRF-guarded
// fetch. Non-persisting: the caller decides what to do with the text.
//
// Returns null on ANY failure (unreachable URL, JS-rendered/paywalled
// page, no meaningful content) so call sites stay fail-soft.

import { env } from "@omni/env-config";
import { traceable } from "langsmith/traceable";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { fetchTextBounded } from "./fetch-bounded.js";
import { logger } from "../logging/logger.js";

const tracingEnabled = env.LANGSMITH_TRACING === "true";

const ARTICLE_FETCH_MAX_BYTES = 5 * 1024 * 1024;
const ARTICLE_FETCH_TIMEOUT_MS = 20_000;

export interface UrlArticleResult {
  title: string;
  text: string;
  url: string;
}

async function fetchUrlArticleImpl(
  url: string,
): Promise<UrlArticleResult | null> {
  let html: string;
  try {
    html = await fetchTextBounded(url, {
      maxBytes: ARTICLE_FETCH_MAX_BYTES,
      timeoutMs: ARTICLE_FETCH_TIMEOUT_MS,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; OmniBot/1.0)",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    logger.warn({ err, url }, "[fetchUrlArticle] fetch failed");
    return null;
  }

  try {
    // Readability only reads the DOM tree — scripts never execute.
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (
      !article ||
      !article.textContent ||
      article.textContent.trim().length < 100
    ) {
      // JS-rendered, paywalled, or not an article (homepage / app shell).
      logger.warn({ url }, "[fetchUrlArticle] no meaningful content");
      return null;
    }
    const fallbackTitle = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return url;
      }
    })();
    return {
      title: (article.title || fallbackTitle).slice(0, 300),
      text: article.textContent.trim(),
      url,
    };
  } catch (err) {
    logger.warn({ err, url }, "[fetchUrlArticle] extraction threw");
    return null;
  }
}

/**
 * Fetch a URL and extract the readable article as plain text.
 * Traced in LangSmith only when LANGSMITH_TRACING === "true".
 */
export const fetchUrlArticle: (
  url: string,
) => Promise<UrlArticleResult | null> = tracingEnabled
  ? (traceable(fetchUrlArticleImpl, {
      name: "fetchUrlArticle",
      run_type: "tool",
    }) as unknown as typeof fetchUrlArticleImpl)
  : fetchUrlArticleImpl;

// Cheap preflight: "is this even an article URL?" — lets tools skip a
// full extraction round-trip for obvious non-articles.
export function looksLikeArticleUrl(url: string): boolean {
  try {
    const u = new URL(url);
    // Exclude obvious asset / API paths.
    if (/\.(pdf|zip|json|xml|jpg|png|gif|svg|mp4|mp3)(\?|$)/i.test(u.pathname)) {
      return false;
    }
    // Exclude social-media hosts where Readability doesn't reliably
    // extract a single piece of content.
    if (
      ["twitter.com", "x.com", "facebook.com", "instagram.com", "tiktok.com"].includes(
        u.hostname.replace(/^www\./, ""),
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
