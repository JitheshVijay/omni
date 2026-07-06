import { test, expect } from "@playwright/test";
import { getData } from "./_helpers";

// MCP host + broadened connectors + built-in tools. MCP assertions are
// conditional on an mcp.json being present (it's gitignored), so this stays
// green in CI without one.

test("mcp host: /api/mcp/servers returns a valid status shape", async ({ request }) => {
  const data = await getData(request, "/api/mcp/servers");
  expect(Array.isArray(data.servers)).toBe(true);
  expect(typeof data.totalTools).toBe("number");
  // If a server is configured (local mcp.json), it should report tool count.
  for (const s of data.servers) {
    expect(s.name).toBeTruthy();
    expect(["connected", "error", "disabled"]).toContain(s.status);
    if (s.status === "connected") expect(s.toolCount).toBeGreaterThan(0);
  }
});

test("connectors: full catalog, fail-soft without COMPOSIO_API_KEY", async ({ request }) => {
  const data = await getData(request, "/api/connectors");
  expect(data.connectors.length).toBeGreaterThanOrEqual(18);
  // A few expected apps across categories.
  const toolkits = data.connectors.map((c: any) => c.toolkit);
  for (const t of ["slack", "notion", "github", "googledrive", "gmail"]) {
    expect(toolkits).toContain(t);
  }
  if (!data.configured) {
    // Every app is "none"/unconnected and connect is refused.
    const connect = await request.post("/api/connectors/slack/connect", {
      headers: { Authorization: "Bearer local" },
    });
    expect(connect.status()).toBe(400);
    expect((await connect.json()).code).toBe("connectors_unconfigured");
  }
});
