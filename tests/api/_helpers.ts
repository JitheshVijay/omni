import type { APIRequestContext } from "@playwright/test";

// Single-user local mode: the API injects LOCAL_USER_ID; the Bearer value is
// only there to keep the header shape of the eventual multi-user mode.
export const AUTH_HEADERS = { Authorization: "Bearer local" };

export async function getData<T = any>(
  request: APIRequestContext,
  path: string
): Promise<T> {
  const res = await request.get(path, { headers: AUTH_HEADERS });
  if (!res.ok()) throw new Error(`GET ${path} -> ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  if (!body.success) throw new Error(`GET ${path} envelope failure: ${JSON.stringify(body)}`);
  return body.data as T;
}

export async function postData<T = any>(
  request: APIRequestContext,
  path: string,
  data?: unknown
): Promise<T> {
  const res = await request.post(path, { headers: AUTH_HEADERS, data });
  if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  if (!body.success) throw new Error(`POST ${path} envelope failure: ${JSON.stringify(body)}`);
  return body.data as T;
}

/** Parse a buffered SSE body into its JSON data events. */
export function parseSSE(bodyText: string): Array<Record<string, any>> {
  const events: Array<Record<string, any>> = [];
  for (const frame of bodyText.split("\n\n")) {
    const line = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    try {
      events.push(JSON.parse(line.slice(5).trim()));
    } catch {
      // ignore malformed frames (padding, partials)
    }
  }
  return events;
}

/** Cheap model for tests — a few hundred tokens per run. */
export const TEST_MODEL = "anthropic/claude-haiku-4-5";
