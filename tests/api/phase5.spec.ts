import { test, expect } from "@playwright/test";
import { AUTH_HEADERS, getData, postData } from "./_helpers";

test.describe.configure({ timeout: 180_000 });

test("semantic search finds a freshly-created doc across the index", async ({ request }) => {
  const marker = `Zephyrine ${Date.now()}`;
  // Create a doc artifact by generating a tiny one.
  const gen = await request.post("/api/generate/doc", {
    headers: AUTH_HEADERS,
    data: {
      prompt: `Write two sentences about a fictional invention called the ${marker} Reactor.`,
      length: "short",
      model: "anthropic/claude-haiku-4-5",
    },
  });
  const body = await gen.text();
  const artifact = body
    .split("\n\n")
    .map((f) => f.split("\n").find((l) => l.startsWith("data:")))
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l!.slice(5).trim());
      } catch {
        return null;
      }
    })
    .find((e) => e?.type === "artifact")?.artifact;
  expect(artifact).toBeTruthy();

  // Reindex, then search should surface it near the top.
  await request.post("/api/search/reindex", { headers: AUTH_HEADERS, data: {} });
  await new Promise((r) => setTimeout(r, 6_000));

  const search = await getData(
    request,
    `/api/search?q=${encodeURIComponent(marker + " Reactor invention")}&k=5`
  );
  expect(["semantic", "keyword"]).toContain(search.mode);
  const hit = search.results.find((r: any) => r.ref_id === artifact.id);
  expect(hit, JSON.stringify(search.results.slice(0, 3))).toBeTruthy();
  expect(hit.href).toContain("/tools/docs/");

  await request.delete(`/api/artifacts/${artifact.id}`, { headers: AUTH_HEADERS });
});

test("secretary is fail-soft without COMPOSIO_API_KEY", async ({ request }) => {
  const status = await getData(request, "/api/secretary/status");
  if (status.configured) {
    test.skip(true, "Composio key present — fail-soft path not applicable");
    return;
  }
  expect(status.connections).toEqual([]);
  const connect = await request.post("/api/secretary/connect", {
    headers: AUTH_HEADERS,
    data: { toolkit: "gmail" },
  });
  expect(connect.status()).toBe(400);
  expect((await connect.json()).code).toBe("secretary_unconfigured");
});

test("voice agent session is fail-soft without ELEVENLABS_API_KEY", async ({ request }) => {
  const voices = await getData(request, "/api/voice/voices");
  test.skip(voices.configured, "voice key present — fail-soft path not applicable");
  const res = await request.post("/api/voice/agent/session", {
    headers: AUTH_HEADERS,
    data: {},
  });
  expect(res.status()).toBe(400);
  expect((await res.json()).code).toBe("voice_unconfigured");
});

test("secretary brief spawns an agent run", async ({ request }) => {
  const status = await getData(request, "/api/secretary/status");
  const res = await request.post("/api/secretary/brief", { headers: AUTH_HEADERS, data: {} });
  // With Composio unconfigured the run still spawns (it'll just note no tools).
  expect(res.ok()).toBe(true);
  const runId = (await res.json()).data.run_id;
  expect(runId).toBeTruthy();
  // The run exists in the agent runs list.
  const run = await getData(request, `/api/agent/runs/${runId}`);
  expect(run.id).toBe(runId);
  // Cancel it to avoid a long unrelated run during the suite.
  await request.post(`/api/agent/runs/${runId}/cancel`, { headers: AUTH_HEADERS });
  void status;
});
