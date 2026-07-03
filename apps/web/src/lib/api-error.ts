// Parse a non-OK fetch response into a clean user-facing error message +
// structured metadata. Replaces the noisy `throw new Error(await r.text())`
// pattern that dumps raw JSON into error UI.
//
// The Omni API envelope is `{success:false, error, code?}` where `error` is
// usually a string but may be a Zod issues array on 400s — both are handled.

export interface ParsedApiError {
  message: string;
  status: number;
  code: string | null;
}

interface ZodIssueLike {
  message?: string;
  path?: (string | number)[];
}

function issuesToMessage(issues: ZodIssueLike[]): string {
  const parts = issues
    .map((i) => {
      const path = Array.isArray(i.path) && i.path.length > 0 ? `${i.path.join(".")}: ` : "";
      return i.message ? `${path}${i.message}` : "";
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : "Invalid request.";
}

export async function parseApiError(r: Response): Promise<ParsedApiError> {
  const status = r.status;
  let raw: string;
  try {
    raw = await r.text();
  } catch {
    raw = "";
  }
  let message = raw || "Request failed.";
  let code: string | null = null;
  try {
    const j = JSON.parse(raw) as { error?: unknown; code?: unknown };
    if (j && typeof j === "object") {
      if (typeof j.error === "string") message = j.error;
      else if (Array.isArray(j.error)) message = issuesToMessage(j.error as ZodIssueLike[]);
      if (typeof j.code === "string") code = j.code;
    }
  } catch {
    // not JSON; keep raw text as the message
  }
  return { message, status, code };
}
