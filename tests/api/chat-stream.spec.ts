import { test, expect } from "@playwright/test";
import { AUTH_HEADERS, getData, parseSSE, postData, TEST_MODEL } from "./_helpers";

// Real OpenRouter calls with the cheap model — a fraction of a cent per run.
test.describe.configure({ timeout: 180_000 });

test("SSE chat turn streams deltas and persists usage", async ({ request }) => {
  const thread = await postData(request, "/api/chat/threads", { model: TEST_MODEL });

  const res = await request.post(`/api/chat/threads/${thread.id}/messages`, {
    headers: AUTH_HEADERS,
    data: { content: "Reply with exactly: SMOKE OK" },
  });
  expect(res.ok()).toBe(true);
  expect(res.headers()["content-type"]).toContain("text/event-stream");

  const events = parseSSE(await res.text());
  const types = events.map((e) => e.type);
  expect(types).toContain("start");
  expect(types.filter((t) => t === "delta").length).toBeGreaterThanOrEqual(1);
  const done = events.find((e) => e.type === "done");
  expect(done).toBeTruthy();
  expect(done!.text).toContain("SMOKE OK");

  const persisted = await getData(request, `/api/chat/threads/${thread.id}`);
  const assistant = persisted.messages.find((m: any) => m.role === "assistant");
  expect(assistant.content).toContain("SMOKE OK");
  const usage =
    typeof assistant.usage === "string" ? JSON.parse(assistant.usage) : assistant.usage;
  expect(usage.cost_usd).toBeGreaterThan(0);

  await request.delete(`/api/chat/threads/${thread.id}`, { headers: AUTH_HEADERS });
});

test("drive upload -> index -> hub memory search -> grounded citations", async ({
  request,
}) => {
  const hub = await postData(request, "/api/hubs", {
    name: `Smoke Hub ${Date.now()}`,
    instructions: "Answer in one short sentence.",
  });

  const marker = `XQ-${Date.now()}`;
  const upload = await request.post("/api/drive/files", {
    headers: AUTH_HEADERS,
    multipart: {
      file: {
        name: "smoke-notes.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(
          `# Smoke Notes\n\nThe launch password for the smoke test rocket is ${marker}. ` +
            `It was chosen by the flight director on a rainy Tuesday.\n`
        ),
      },
    },
  });
  expect(upload.ok()).toBe(true);
  const file = (await upload.json()).data;

  await postData(request, `/api/hubs/${hub.id}/files`, { file_id: file.id });

  // Indexer tick is 15s; poll up to 60s for ready.
  let status = "";
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const f = await getData(request, `/api/drive/files/${file.id}`);
    status = f.index_status;
    if (status === "ready" || status === "failed") break;
  }
  expect(status).toBe("ready");

  const search = await postData(request, `/api/hubs/${hub.id}/memory/search`, {
    query: "what is the launch password?",
    k: 3,
  });
  const results = search.results ?? search;
  expect(results.length).toBeGreaterThanOrEqual(1);
  expect(results[0].chunk_text).toContain(marker);

  // Grounded turn: thread in the hub must cite the doc and surface the marker.
  const thread = await postData(request, "/api/chat/threads", {
    hub_id: hub.id,
    model: TEST_MODEL,
  });
  const res = await request.post(`/api/chat/threads/${thread.id}/messages`, {
    headers: AUTH_HEADERS,
    data: { content: "What is the launch password for the smoke test rocket?" },
  });
  const events = parseSSE(await res.text());
  const sources = events.find((e) => e.type === "sources");
  expect(sources).toBeTruthy();
  const done = events.find((e) => e.type === "done");
  expect(done!.text).toContain(marker);

  // Cleanup: thread, hub, file (cascades chunks + vec rows).
  await request.delete(`/api/chat/threads/${thread.id}`, { headers: AUTH_HEADERS });
  await request.delete(`/api/hubs/${hub.id}`, { headers: AUTH_HEADERS });
  await request.delete(`/api/drive/files/${file.id}`, { headers: AUTH_HEADERS });
});
