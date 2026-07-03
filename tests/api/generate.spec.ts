import { test, expect } from "@playwright/test";
import { AUTH_HEADERS, getData, parseSSE, postData, TEST_MODEL } from "./_helpers";

// Real OpenRouter calls: two image generations (~cents) + cheap-model docs.
test.describe.configure({ timeout: 300_000 });

async function generate(
  request: any,
  name: string,
  body: unknown
): Promise<Array<Record<string, any>>> {
  const res = await request.post(`/api/generate/${name}`, {
    headers: AUTH_HEADERS,
    data: body,
  });
  expect(res.ok()).toBe(true);
  expect(res.headers()["content-type"]).toContain("text/event-stream");
  return parseSSE(await res.text());
}

test("image: generate -> blob -> revise with lineage -> delete", async ({ request }) => {
  const events = await generate(request, "image", {
    prompt: "A tiny robot watering a sunflower, flat vector illustration",
    aspect_ratio: "16:9",
  });
  const artifact = events.find((e) => e.type === "artifact")?.artifact;
  expect(artifact, JSON.stringify(events.slice(-2))).toBeTruthy();
  expect(artifact.kind).toBe("image");
  expect(artifact.rel_path).toMatch(/^artifacts\/.+\.png$/);

  const blob = await request.get(`/api/artifacts/${artifact.id}/blob`, {
    headers: AUTH_HEADERS,
  });
  expect(blob.ok()).toBe(true);
  expect(blob.headers()["content-type"]).toContain("image/png");
  expect((await blob.body()).length).toBeGreaterThan(10_000);

  // Revise -> child artifact with parent_id lineage
  const reviseRes = await request.post(`/api/artifacts/${artifact.id}/revise`, {
    headers: AUTH_HEADERS,
    data: { instruction: "Make it night time, moonlit" },
  });
  expect(reviseRes.ok()).toBe(true);
  const reviseEvents = parseSSE(await reviseRes.text());
  const child = reviseEvents.find((e) => e.type === "artifact")?.artifact;
  expect(child, JSON.stringify(reviseEvents.slice(-2))).toBeTruthy();
  expect(child.parent_id).toBe(artifact.id);

  // List shows both, newest first
  const list = await getData(request, "/api/artifacts?kind=image&limit=10");
  const ids = list.artifacts.map((a: any) => a.id);
  expect(ids).toContain(artifact.id);
  expect(ids).toContain(child.id);

  for (const id of [child.id, artifact.id]) {
    const del = await request.delete(`/api/artifacts/${id}`, { headers: AUTH_HEADERS });
    expect(del.ok()).toBe(true);
  }
});

test("doc: hub-grounded generation -> sources -> patch -> export-to-drive", async ({
  request,
}) => {
  // Self-contained hub with an indexed marker doc.
  const hub = await postData(request, "/api/hubs", { name: `DocGen Hub ${Date.now()}` });
  const marker = `ZR-${Date.now()}`;
  const upload = await request.post("/api/drive/files", {
    headers: AUTH_HEADERS,
    multipart: {
      file: {
        name: "facts.md",
        mimeType: "text/markdown",
        buffer: Buffer.from(
          `# Falcon Kite\n\nThe Falcon Kite drone has a wingspan of 3.2 meters and its ` +
            `serial prefix is ${marker}. It flies for 90 minutes per charge.\n`
        ),
      },
    },
  });
  const file = (await upload.json()).data;
  await postData(request, `/api/hubs/${hub.id}/files`, { file_id: file.id });
  let status = "";
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    status = (await getData(request, `/api/drive/files/${file.id}`)).index_status;
    if (status === "ready" || status === "failed") break;
  }
  expect(status).toBe("ready");

  const events = await generate(request, "doc", {
    prompt: "Write a short spec brief about the Falcon Kite drone.",
    hub_id: hub.id,
    length: "short",
    model: TEST_MODEL,
  });
  const deltas = events.filter((e) => e.type === "delta" && e.channel === "markdown");
  expect(deltas.length).toBeGreaterThanOrEqual(1);
  const artifact = events.find((e) => e.type === "artifact")?.artifact;
  expect(artifact, JSON.stringify(events.slice(-2))).toBeTruthy();
  expect(artifact.kind).toBe("doc");

  const detail = await getData(request, `/api/artifacts/${artifact.id}`);
  expect(detail.content.markdown.length).toBeGreaterThan(100);
  expect(detail.content.sources.length).toBeGreaterThanOrEqual(1);
  expect(detail.content.markdown).toContain(marker);

  // PATCH title
  const patched = await request.patch(`/api/artifacts/${artifact.id}`, {
    headers: AUTH_HEADERS,
    data: { title: "Falcon Kite Brief" },
  });
  expect(patched.ok()).toBe(true);
  expect((await patched.json()).data.title).toBe("Falcon Kite Brief");

  // Export to Drive -> generated markdown drive file
  const exported = await postData(request, `/api/artifacts/${artifact.id}/export-to-drive`);
  expect(exported.origin).toBe("generated");
  expect(exported.mime).toContain("markdown");

  // Cleanup
  await request.delete(`/api/artifacts/${artifact.id}`, { headers: AUTH_HEADERS });
  await request.delete(`/api/drive/files/${exported.id}`, { headers: AUTH_HEADERS });
  await request.delete(`/api/drive/files/${file.id}`, { headers: AUTH_HEADERS });
  await request.delete(`/api/hubs/${hub.id}`, { headers: AUTH_HEADERS });
});

test("voice endpoints fail soft without ELEVENLABS_API_KEY", async ({ request }) => {
  const voices = await getData(request, "/api/voice/voices");
  if (voices.configured) {
    test.skip(true, "ElevenLabs key present — fail-soft path not applicable");
    return;
  }
  expect(voices.voices).toEqual([]);

  const tts = await request.post("/api/voice/tts", {
    headers: AUTH_HEADERS,
    data: { text: "hello" },
  });
  expect(tts.status()).toBe(400);
  expect((await tts.json()).code).toBe("voice_unconfigured");

  const gen = await request.post("/api/generate/tts", {
    headers: AUTH_HEADERS,
    data: { text: "hello world" },
  });
  const events = parseSSE(await gen.text());
  const err = events.find((e) => e.type === "error");
  expect(err?.message ?? "").toContain("voice not configured");
});

test("unknown generator 404s; invalid input 400s before hijack", async ({ request }) => {
  const notFound = await request.post("/api/generate/nope", {
    headers: AUTH_HEADERS,
    data: { prompt: "x" },
  });
  expect(notFound.status()).toBe(404);

  const bad = await request.post("/api/generate/image", {
    headers: AUTH_HEADERS,
    data: { prompt: "" },
  });
  expect(bad.status()).toBe(400);
  expect((await bad.json()).success).toBe(false);
});
