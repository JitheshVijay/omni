// Pure unit tests for the Composio layer that DON'T need a live COMPOSIO_API_KEY:
// the read/write slug classifier (the safety-critical confirmation gate) and the
// fail-soft "unavailable"/empty shapes when the key is unset. Live OAuth connect,
// real inbox reads, and actual sends are unverifiable here and covered manually.
import { describe, it, expect } from "vitest";
import {
  composioEnabled,
  composioToolKind,
  describeComposioAction,
  isComposioToolName,
  isSecretaryToolkit,
  connectToolkit,
  composioToolsForUser,
  executeComposioTool,
  SECRETARY_TOOLKITS,
} from "./composio.js";

// The suite runs without COMPOSIO_API_KEY set (env-config marks it optional).
const KEY_PRESENT = !!process.env.COMPOSIO_API_KEY;

describe("composioToolKind — read/write classifier", () => {
  it("classifies unambiguous reads as read", () => {
    for (const slug of [
      "GMAIL_LIST_MESSAGES",
      "GMAIL_FETCH_EMAILS",
      "GMAIL_GET_MESSAGE",
      "GMAIL_SEARCH_EMAILS",
      "GOOGLECALENDAR_LIST_EVENTS",
      "GOOGLECALENDAR_GET_EVENT",
      "GOOGLECALENDAR_FIND_EVENT",
    ]) {
      expect(composioToolKind(slug)).toBe("read");
    }
  });

  it("classifies mutations as write", () => {
    for (const slug of [
      "GMAIL_SEND_EMAIL",
      "GMAIL_REPLY_TO_THREAD",
      "GMAIL_CREATE_DRAFT",
      "GMAIL_DELETE_MESSAGE",
      "GMAIL_TRASH_MESSAGE",
      "GOOGLECALENDAR_CREATE_EVENT",
      "GOOGLECALENDAR_UPDATE_EVENT",
      "GOOGLECALENDAR_DELETE_EVENT",
    ]) {
      expect(composioToolKind(slug)).toBe("write");
    }
  });

  it("treats a read verb with a hidden mutation token as write (upsert guard)", () => {
    // Leading verb GET/FIND but a CREATE segment → must NOT run unconfirmed.
    expect(composioToolKind("GMAIL_GET_OR_CREATE_LABEL")).toBe("write");
    expect(composioToolKind("GOOGLECALENDAR_FIND_OR_CREATE_EVENT")).toBe("write");
  });

  it("defaults unknown leading verbs to write (safe-by-default)", () => {
    expect(composioToolKind("GMAIL_SYNC_MAILBOX")).toBe("write");
    expect(composioToolKind("GOOGLECALENDAR_QUICK_EVENT")).toBe("write");
  });
});

describe("isComposioToolName", () => {
  it("matches UPPERCASE_UNDERSCORED Composio slugs", () => {
    expect(isComposioToolName("GMAIL_SEND_EMAIL")).toBe(true);
    expect(isComposioToolName("GOOGLECALENDAR_LIST_EVENTS")).toBe(true);
  });
  it("rejects native snake_case tool names", () => {
    expect(isComposioToolName("web_search")).toBe(false);
    expect(isComposioToolName("drive_read")).toBe(false);
  });
});

describe("describeComposioAction", () => {
  it("humanizes a slug into an app: action label", () => {
    expect(describeComposioAction("GMAIL_SEND_EMAIL")).toBe("Gmail: send email");
    expect(describeComposioAction("GOOGLECALENDAR_CREATE_EVENT")).toBe("Calendar: create event");
  });
});

describe("isSecretaryToolkit", () => {
  it("accepts the two in-scope toolkits", () => {
    expect(isSecretaryToolkit("gmail")).toBe(true);
    expect(isSecretaryToolkit("googlecalendar")).toBe(true);
    expect(SECRETARY_TOOLKITS).toEqual(["gmail", "googlecalendar"]);
  });
  it("rejects out-of-scope toolkits", () => {
    expect(isSecretaryToolkit("slack")).toBe(false);
    expect(isSecretaryToolkit("github")).toBe(false);
  });
});

// These guards only assert the fail-soft path when the key is UNSET. When a key
// happens to be present (CI with a real key) they'd hit the network, so skip.
describe.skipIf(KEY_PRESENT)("fail-soft when COMPOSIO_API_KEY is unset", () => {
  it("composioEnabled() is false", () => {
    expect(composioEnabled()).toBe(false);
  });

  it("connectToolkit returns an unavailable shape (no throw)", async () => {
    const r = await connectToolkit("user-1", "gmail");
    expect(r).toEqual({ status: "unavailable" });
    expect(r.redirectUrl).toBeUndefined();
  });

  it("composioToolsForUser returns [] (no throw)", async () => {
    await expect(composioToolsForUser("user-1", ["gmail", "googlecalendar"])).resolves.toEqual([]);
  });

  it("executeComposioTool returns a not-configured envelope (no throw)", async () => {
    const out = await executeComposioTool("user-1", "GMAIL_SEND_EMAIL", { to: "x@y.com" });
    expect(JSON.parse(out)).toEqual({ error: "composio_not_configured" });
  });
});
