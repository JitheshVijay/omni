import { test, expect } from "@playwright/test";
import { AUTH_HEADERS, getData, postData, TEST_MODEL } from "./_helpers";

test("health responds", async ({ request }) => {
  const res = await request.get("/health");
  expect(res.ok()).toBe(true);
  const body = await res.json();
  expect(body.status).toBe("ok");
});

test("settings expose key status and storage debug block", async ({ request }) => {
  const data = await getData(request, "/api/settings");
  expect(data.default_model).toBeTruthy();
  expect(data.keys.openrouter.configured).toBe(true);
  expect(data.storage.vec).toBe(true);
  expect(data.storage.tables).toBeGreaterThanOrEqual(10);
});

test("models list contains curated ids", async ({ request }) => {
  const data = await getData<{ models: Array<{ id: string }> }>(request, "/api/models");
  const ids = data.models.map((m) => m.id);
  expect(ids).toContain("anthropic/claude-sonnet-5");
  expect(ids).toContain("anthropic/claude-haiku-4-5");
});

test("thread CRUD round-trip", async ({ request }) => {
  const created = await postData(request, "/api/chat/threads", { model: TEST_MODEL });
  expect(created.id).toBeTruthy();

  const patched = await request.patch(`/api/chat/threads/${created.id}`, {
    headers: AUTH_HEADERS,
    data: { title: "Smoke thread" },
  });
  expect(patched.ok()).toBe(true);

  const fetched = await getData(request, `/api/chat/threads/${created.id}`);
  expect(fetched.title).toBe("Smoke thread");

  const deleted = await request.delete(`/api/chat/threads/${created.id}`, {
    headers: AUTH_HEADERS,
  });
  expect(deleted.ok()).toBe(true);

  const gone = await request.get(`/api/chat/threads/${created.id}`, {
    headers: AUTH_HEADERS,
  });
  expect(gone.status()).toBe(404);
});

test("invalid body returns a 400 with zod issues", async ({ request }) => {
  const res = await request.post("/api/chat/threads", {
    headers: AUTH_HEADERS,
    data: { model: 123 },
  });
  expect(res.status()).toBe(400);
  const body = await res.json();
  expect(body.success).toBe(false);
});
