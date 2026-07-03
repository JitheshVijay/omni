import { test, expect } from "@playwright/test";
import { AUTH_HEADERS, getData, parseSSE, postData } from "./_helpers";

// A real autonomous run (web_search + create_doc) + a slides generation.
// Costs ~$0.20 of OpenRouter; give it room.
test.describe.configure({ timeout: 300_000 });

test("agent run: plan -> web_search -> create_doc -> completed", async ({ request }) => {
  const run = await postData(request, "/api/agent/runs", {
    goal:
      "Use web search to find one fact about honeybees, then create a one-paragraph " +
      'document titled "Bee Fact" summarizing it.',
    budget_usd: 0.5,
  });
  expect(run.id).toBeTruthy();
  expect(["queued", "planning", "running"]).toContain(run.status);

  // Poll the detail endpoint to a terminal state.
  let detail: any;
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4_000));
    detail = await getData(request, `/api/agent/runs/${run.id}`);
    if (["completed", "failed", "cancelled"].includes(detail.status)) break;
  }
  expect(detail.status, JSON.stringify({ status: detail.status, err: detail.error })).toBe(
    "completed"
  );
  expect(detail.steps.length).toBeGreaterThan(2);
  expect((detail.final_output ?? "").length).toBeGreaterThan(20);
  expect(detail.cost_usd).toBeGreaterThan(0);

  // Plan was maintained and every item resolved.
  expect(Array.isArray(detail.plan)).toBe(true);
  expect(detail.plan.length).toBeGreaterThanOrEqual(1);
  expect(detail.plan.every((p: any) => ["done", "skipped", "failed"].includes(p.status))).toBe(
    true
  );

  // A doc artifact was created and linked to the run.
  const stream = await request.get(`/api/agent/runs/${run.id}/stream?after=0`, {
    headers: AUTH_HEADERS,
    timeout: 15_000,
  });
  const events = parseSSE(await stream.text());
  const artifactEvent = events.find((e) => e.type === "artifact_created");
  expect(artifactEvent, "expected an artifact_created event").toBeTruthy();
  expect(artifactEvent!.artifact.kind).toBe("doc");

  // Steps carry a parsed `event` for snapshot replay (no raw-JSON leak in UI).
  const asst = detail.steps.find((s: any) => s.kind === "assistant_message");
  expect(asst?.event?.type).toBe("assistant_message");
  expect(typeof asst?.event?.text).toBe("string");
});

test("slides generator produces a themed multi-archetype deck", async ({ request }) => {
  const res = await request.post("/api/generate/slides", {
    headers: AUTH_HEADERS,
    data: {
      prompt: "A 4-slide overview of why walking is good for you",
      slide_count: 4,
      theme: "forest",
    },
  });
  expect(res.ok()).toBe(true);
  const events = parseSSE(await res.text());
  const artifact = events.find((e) => e.type === "artifact")?.artifact;
  expect(artifact, JSON.stringify(events.slice(-2))).toBeTruthy();
  expect(artifact.kind).toBe("slides");

  const detail = await getData(request, `/api/artifacts/${artifact.id}`);
  expect(detail.content.slides.length).toBeGreaterThanOrEqual(3);
  expect(detail.content.theme).toBeTruthy();
  expect(detail.content.slides[0].archetype).toBeTruthy();

  await request.delete(`/api/artifacts/${artifact.id}`, { headers: AUTH_HEADERS });
});

test("agent cancel transitions a mid-flight run to cancelled", async ({ request }) => {
  // A goal that forces several tool iterations so the run is provably busy when
  // we cancel (a short goal can complete from the model's own knowledge before
  // the cancel lands — that would be a race, not a cancel failure).
  const run = await postData(request, "/api/agent/runs", {
    goal:
      "Use web search separately for the capital city of France, then Japan, then " +
      "Brazil, then Egypt, reading a source for each, then write a document listing all four.",
    budget_usd: 0.4,
  });

  // Wait until it's genuinely working: a tool step exists and it's not terminal.
  let midFlight: any;
  const startDeadline = Date.now() + 45_000;
  while (Date.now() < startDeadline) {
    await new Promise((r) => setTimeout(r, 2_000));
    midFlight = await getData(request, `/api/agent/runs/${run.id}`);
    const hasToolStep = (midFlight.steps ?? []).some((s: any) => s.kind === "tool_call");
    if (["completed", "failed", "cancelled"].includes(midFlight.status)) break;
    if (hasToolStep) break;
  }
  test.skip(
    ["completed", "failed", "cancelled"].includes(midFlight.status),
    "run finished before it could be cancelled mid-flight"
  );

  const cancel = await request.post(`/api/agent/runs/${run.id}/cancel`, {
    headers: AUTH_HEADERS,
  });
  expect(cancel.ok()).toBe(true);

  let detail: any;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    detail = await getData(request, `/api/agent/runs/${run.id}`);
    if (["cancelled", "completed", "failed"].includes(detail.status)) break;
  }
  expect(detail.status).toBe("cancelled");
});
