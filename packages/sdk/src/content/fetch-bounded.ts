// Safe wrapper around `fetch` that caps response size and time. The
// plain `await res.text()` pattern is a memory-exhaustion DoS vector:
// a hostile URL can serve a multi-GB body and the backend allocates
// the whole buffer before any downstream truncation can run. This
// helper:
//   - Aborts the request after `timeoutMs` (default 15s).
//   - Rejects up-front if the server advertises a Content-Length
//     larger than `maxBytes`.
//   - Streams the body chunk-by-chunk and aborts the moment the
//     accumulated bytes exceed `maxBytes`, even if Content-Length
//     was missing or lied.
//   - Decodes as UTF-8 and returns the (possibly capped) text.
//   - Enforces an SSRF guard: rejects non-http(s) schemes, DNS-
//     resolves the host and refuses loopback / link-local / private
//     / multicast / metadata IPs (covers 169.254.169.254, RFC1918,
//     IPv6 ULA + link-local). Redirects are followed MANUALLY and the
//     guard re-runs against every hop so a public domain that 30x's
//     to an internal IP still fails closed.
//   - Closes the DNS-rebinding TOCTOU: the host is resolved ONCE and
//     the socket is PINNED to the validated IP via an undici dispatcher
//     with a custom `connect.lookup`, so the connection can only dial
//     the address we checked. SNI/Host stay the original hostname, so
//     TLS still validates against the cert.
//
// Use for any fetch where the URL is user-controlled (fetchUrlArticle,
// agent fetch_url tool, future RSS / Open Graph scrapers). Hard-coded
// trusted endpoints (OpenRouter, ElevenLabs, LlamaParse, Exa) should
// keep using plain fetch — pinned hosts don't need the SSRF check.

import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { fetch as undiciFetch, Agent } from "undici";

export interface FetchTextBoundedOptions {
  // Cap on response body size in bytes. Reject if Content-Length
  // advertises larger; abort mid-stream if the body exceeds it.
  maxBytes: number;
  // Hard timeout via AbortController. Default 15_000.
  timeoutMs?: number;
  headers?: Record<string, string>;
  // Max redirects to follow. Default 5. The native fetch default is
  // ~20; tighter because each hop costs a DNS round-trip for the SSRF
  // check.
  maxRedirects?: number;
  // Opt out of the SSRF guard. Default false. Set ONLY when the URL
  // is a pinned trusted endpoint — never when any part of the URL
  // came from user input.
  allowInternal?: boolean;
}

export class BoundedFetchError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "BoundedFetchError";
    this.status = status;
  }
}

// ─── SSRF guard ───────────────────────────────────────────────────

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

// Hostnames we reject without even resolving (defense in depth — the
// IP check below would catch most of these too).
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  "metadata.google.internal",
  "metadata", // GCP metadata service short name
]);

function ipToNumber(ip: string): number | null {
  if (!net.isIPv4(ip)) return null;
  const parts = ip.split(".").map((s) => Number.parseInt(s, 10));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  return (
    ((parts[0] << 24) >>> 0) +
    (parts[1] << 16) +
    (parts[2] << 8) +
    parts[3]
  );
}

function inV4Range(addr: number, baseStr: string, bits: number): boolean {
  const base = ipToNumber(baseStr);
  if (base == null) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (addr & mask) === (base & mask);
}

// Returns true when `ip` (already known to be a valid IP literal)
// should be refused. Covers IPv4 + IPv6.
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const n = ipToNumber(ip);
    if (n == null) return true; // unparseable -> refuse
    // 0.0.0.0/8 — "this network"
    if (inV4Range(n, "0.0.0.0", 8)) return true;
    // 10.0.0.0/8 — RFC1918 private
    if (inV4Range(n, "10.0.0.0", 8)) return true;
    // 100.64.0.0/10 — CGNAT
    if (inV4Range(n, "100.64.0.0", 10)) return true;
    // 127.0.0.0/8 — loopback
    if (inV4Range(n, "127.0.0.0", 8)) return true;
    // 169.254.0.0/16 — link-local (includes 169.254.169.254 metadata)
    if (inV4Range(n, "169.254.0.0", 16)) return true;
    // 172.16.0.0/12 — RFC1918 private
    if (inV4Range(n, "172.16.0.0", 12)) return true;
    // 192.0.0.0/24 — IETF protocol assignments
    if (inV4Range(n, "192.0.0.0", 24)) return true;
    // 192.0.2.0/24 — TEST-NET-1 (documentation only)
    if (inV4Range(n, "192.0.2.0", 24)) return true;
    // 192.168.0.0/16 — RFC1918 private
    if (inV4Range(n, "192.168.0.0", 16)) return true;
    // 198.18.0.0/15 — network benchmark
    if (inV4Range(n, "198.18.0.0", 15)) return true;
    // 198.51.100.0/24 — TEST-NET-2 (documentation only)
    if (inV4Range(n, "198.51.100.0", 24)) return true;
    // 203.0.113.0/24 — TEST-NET-3 (documentation only)
    if (inV4Range(n, "203.0.113.0", 24)) return true;
    // 224.0.0.0/4 — multicast
    if (inV4Range(n, "224.0.0.0", 4)) return true;
    // 240.0.0.0/4 — reserved (includes 255.255.255.255 broadcast)
    if (inV4Range(n, "240.0.0.0", 4)) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    // Strip the optional zone-id suffix (`fe80::1%eth0`) before checks.
    const lower = ip.toLowerCase().replace(/%.*$/, "");
    // ::, ::1
    if (lower === "::" || lower === "::1") return true;
    // IPv4-mapped IPv6 — extract the embedded IPv4 and re-check. TWO
    // textual forms reach us and BOTH must be handled: the dotted form
    // (::ffff:169.254.169.254) AND the hex-compressed form
    // (::ffff:a9fe:a9fe) that `new URL()` normalises literals to.
    const v4MappedDotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (v4MappedDotted && net.isIPv4(v4MappedDotted[1])) return isBlockedIp(v4MappedDotted[1]);
    const v4MappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (v4MappedHex) {
      const hi = Number.parseInt(v4MappedHex[1], 16);
      const lo = Number.parseInt(v4MappedHex[2], 16);
      const dotted = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
      if (net.isIPv4(dotted)) return isBlockedIp(dotted);
    }
    // fc00::/7 — Unique Local Address (RFC 4193)
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    // fe80::/10 — link-local
    if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
        lower.startsWith("fea") || lower.startsWith("feb")) return true;
    // fec0::/10 — deprecated site-local (RFC 3879). Block defensively.
    if (lower.startsWith("fec") || lower.startsWith("fed") ||
        lower.startsWith("fee") || lower.startsWith("fef")) return true;
    // ff00::/8 — multicast
    if (lower.startsWith("ff")) return true;
    return false;
  }
  // Anything that isn't a recognisable v4 / v6 literal — refuse.
  return true;
}

/** A host that passed validation, plus the exact IP to pin the socket to. */
export interface ValidatedHost {
  /** Lowercased hostname (or IP literal) exactly as the URL parser returns it. */
  hostname: string;
  /** The validated IP literal the connection must dial. */
  address: string;
  /** 4 or 6 — needed for the connect-time lookup callback. */
  family: 4 | 6;
}

/**
 * Resolve `url`'s host, reject if it's not safe to fetch, and RETURN the
 * validated IP so the caller can pin the socket to it.
 *
 * Throws BoundedFetchError on:
 *   - Non-http(s) scheme (file://, data://, gopher://, etc.).
 *   - Embedded credentials (`http://user:pass@host`).
 *   - Hostname on the blocklist (localhost, metadata, etc.).
 *   - DNS resolution failure.
 *   - Any resolved address that's in a blocked IP range.
 *
 * When the host has multiple A/AAAA records (DNS round-robin), EVERY
 * address must pass; we then pin to the first. Pinning closes the
 * DNS-rebinding TOCTOU: without it, `fetch()` re-resolves at connect
 * time, so a TTL-0 attacker domain could answer "public" to the check
 * and "private" to the connect.
 */
export async function resolveAndValidateUrl(url: string): Promise<ValidatedHost> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BoundedFetchError(`Invalid URL: ${url.slice(0, 80)}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new BoundedFetchError(
      `Refused scheme "${parsed.protocol}"; only http(s) allowed.`,
    );
  }
  // Embedded credentials are rejected. Legitimate flows here never use
  // them, and HTTP basic auth via URL has been a vector for confusing
  // proxies into sending headers we didn't intend.
  if (parsed.username || parsed.password) {
    throw new BoundedFetchError("URLs with embedded credentials are not allowed.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    throw new BoundedFetchError(`Refused hostname: ${hostname}`);
  }
  // If the hostname is already a literal IP, skip DNS and check it
  // directly. URL parsing wraps IPv6 literals in brackets — strip them
  // for the IP check / pin (undici connects straight to a literal and
  // never invokes the lookup, so the pin is just belt-and-braces there).
  const bareHost = hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (net.isIP(bareHost)) {
    if (isBlockedIp(bareHost)) {
      throw new BoundedFetchError(`Refused IP: ${bareHost}`);
    }
    return { hostname, address: bareHost, family: net.isIPv6(bareHost) ? 6 : 4 };
  }
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await dnsLookup(hostname, { all: true });
  } catch (err) {
    throw new BoundedFetchError(
      `DNS resolution failed for ${hostname}: ${(err as Error).message?.slice(0, 80)}`,
    );
  }
  if (resolved.length === 0) {
    throw new BoundedFetchError(`No DNS records for ${hostname}`);
  }
  for (const r of resolved) {
    if (isBlockedIp(r.address)) {
      throw new BoundedFetchError(
        `Refused: ${hostname} resolves to blocked IP ${r.address}`,
      );
    }
  }
  // Every record passed — pin to the first.
  const first = resolved[0];
  return { hostname, address: first.address, family: first.family === 6 ? 6 : 4 };
}

/**
 * Assertion-only wrapper for callers that fetch elsewhere and just need
 * the safety check. Prefer resolveAndValidateUrl + pinning when you
 * control the fetch.
 *
 * NOTE: on its own this does NOT close the rebinding window — the
 * caller's fetch re-resolves. Use fetchTextBounded (which pins) for
 * user URLs.
 */
export async function assertUrlSafeForExternalFetch(url: string): Promise<void> {
  await resolveAndValidateUrl(url);
}

/**
 * Build an undici dispatcher whose DNS lookup can only return IPs we have
 * already validated for a given hostname. Anything not in `pins` — or any
 * pinned IP that (re-checked here) is blocked — fails the connection.
 * This is the actual TOCTOU close: the socket dials the validated
 * address, not a freshly-resolved one.
 */
function pinnedDispatcher(pins: Map<string, ValidatedHost>): Agent {
  return new Agent({
    connect: {
      // Node's lookup signature: (hostname, options, callback). net.connect
      // may request `all: true` (autoSelectFamily), so handle both shapes.
      lookup(
        host: string,
        options: { all?: boolean },
        callback: (
          err: NodeJS.ErrnoException | null,
          address: string | Array<{ address: string; family: number }>,
          family?: number,
        ) => void,
      ): void {
        const pin = pins.get(host.toLowerCase());
        if (!pin) {
          callback(new Error(`unvalidated host: ${host}`) as NodeJS.ErrnoException, "", 0);
          return;
        }
        if (isBlockedIp(pin.address)) {
          callback(new Error(`blocked IP: ${pin.address}`) as NodeJS.ErrnoException, "", 0);
          return;
        }
        if (options && options.all) {
          callback(null, [{ address: pin.address, family: pin.family }]);
        } else {
          callback(null, pin.address, pin.family);
        }
      },
    },
  });
}

// ─── Bounded fetcher ───────────────────────────────────────────────

export async function fetchTextBounded(
  url: string,
  opts: FetchTextBoundedOptions,
): Promise<string> {
  const {
    maxBytes,
    timeoutMs = 15_000,
    headers,
    maxRedirects = 5,
    allowInternal = false,
  } = opts;
  if (maxBytes <= 0) {
    throw new BoundedFetchError("maxBytes must be positive");
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  // Per-hop pin table + dispatcher. For pinned trusted callers
  // (allowInternal) we skip validation AND pinning and let undici resolve
  // normally — those hosts are hard-coded, not user input.
  const pins = new Map<string, ValidatedHost>();
  const agent = allowInternal ? undefined : pinnedDispatcher(pins);
  try {
    // Manual redirect loop so we can re-run the SSRF gate against every
    // hop AND pin each hop's connection to the IP we just validated. A
    // public domain that 302s to 169.254.169.254 fails closed at the
    // redirect; a TTL-0 rebind can't swap the IP between check and
    // connect because the socket is pinned to the validated address.
    let currentUrl = url;
    let res: Awaited<ReturnType<typeof undiciFetch>> | null = null;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      if (!allowInternal) {
        const validated = await resolveAndValidateUrl(currentUrl);
        pins.set(validated.hostname, validated);
      }
      const hopRes = await undiciFetch(currentUrl, {
        headers,
        signal: controller.signal,
        redirect: "manual",
        ...(agent ? { dispatcher: agent } : {}),
      });
      const status = hopRes.status;
      if (status >= 300 && status < 400) {
        const loc = hopRes.headers.get("location");
        if (!loc) {
          // 3xx without Location is treated as terminal.
          res = hopRes;
          break;
        }
        if (hop === maxRedirects) {
          throw new BoundedFetchError(
            `Too many redirects (${maxRedirects + 1}).`,
          );
        }
        // Resolve Location against the current URL so relative
        // redirects (e.g. `/foo`) work the same as absolute.
        currentUrl = new URL(loc, currentUrl).href;
        continue;
      }
      res = hopRes;
      break;
    }
    if (res == null) {
      throw new BoundedFetchError("No response after redirect chain.");
    }
    if (!res.ok) {
      throw new BoundedFetchError(
        `Fetch failed: HTTP ${res.status}`,
        res.status,
      );
    }
    // Up-front size check via Content-Length. Hostile servers can lie
    // about this, so we ALSO enforce the cap while streaming below —
    // but rejecting here saves an entire round-trip body when the
    // server honestly reports its size.
    const contentLength = res.headers.get("content-length");
    if (contentLength) {
      const advertised = Number.parseInt(contentLength, 10);
      if (Number.isFinite(advertised) && advertised > maxBytes) {
        controller.abort();
        throw new BoundedFetchError(
          `Response too large: ${advertised} bytes (cap ${maxBytes})`,
        );
      }
    }

    // Stream the body and bail the moment we cross the cap. Avoids
    // calling res.text() which would buffer the entire body before
    // any truncation can run.
    const body = res.body;
    if (!body) {
      throw new BoundedFetchError("Response has no body");
    }
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        controller.abort();
        // Reader.cancel is async; throw without awaiting so the caller
        // gets the error immediately. The connection tears down via
        // AbortController either way.
        throw new BoundedFetchError(
          `Response exceeded byte cap (${maxBytes})`,
        );
      }
      chunks.push(value);
    }
    // Concatenate chunks once we know total <= maxBytes.
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(merged);
  } finally {
    clearTimeout(timeoutId);
    // Release the pinned dispatcher's pooled sockets.
    if (agent) await agent.close().catch(() => {});
  }
}
