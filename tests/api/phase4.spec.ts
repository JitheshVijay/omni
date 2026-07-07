import { test, expect } from "@playwright/test";
import { AUTH_HEADERS, getData, parseSSE, postData, TEST_MODEL } from "./_helpers";

test.describe.configure({ timeout: 300_000 });

test("sheet: streams schema + rows, cell edit persists, revise creates lineage", async ({
  request,
}) => {
  const res = await request.post("/api/generate/sheet", {
    headers: AUTH_HEADERS,
    data: { prompt: "3 primary colors with their hex codes", rows_hint: 3 },
  });
  expect(res.ok()).toBe(true);
  const events = parseSSE(await res.text());
  const schema = events.find((e) => e.type === "delta" && e.channel === "schema");
  expect(schema).toBeTruthy();
  const rowDeltas = events.filter((e) => e.type === "delta" && e.channel === "row");
  expect(rowDeltas.length).toBeGreaterThanOrEqual(2);
  const artifact = events.find((e) => e.type === "artifact")?.artifact;
  expect(artifact.kind).toBe("sheet");

  // Cell edit via PATCH content
  const detail = await getData(request, `/api/artifacts/${artifact.id}`);
  expect(detail.content.columns.length).toBeGreaterThanOrEqual(2);
  const edited = structuredClone(detail.content);
  edited.rows[0][0] = "EDITED CELL";
  const patched = await request.patch(`/api/artifacts/${artifact.id}`, {
    headers: AUTH_HEADERS,
    data: { content: edited },
  });
  expect(patched.ok()).toBe(true);
  const after = await getData(request, `/api/artifacts/${artifact.id}`);
  expect(after.content.rows[0][0]).toBe("EDITED CELL");

  // Revise -> child artifact
  const rev = await request.post(`/api/artifacts/${artifact.id}/revise`, {
    headers: AUTH_HEADERS,
    data: { instruction: "Add a fourth row for the color green" },
  });
  const revEvents = parseSSE(await rev.text());
  const child = revEvents.find((e) => e.type === "artifact")?.artifact;
  expect(child, JSON.stringify(revEvents.slice(-2))).toBeTruthy();
  expect(child.parent_id).toBe(artifact.id);

  for (const id of [child.id, artifact.id])
    await request.delete(`/api/artifacts/${id}`, { headers: AUTH_HEADERS });
});

test("podcast fails soft without ELEVENLABS_API_KEY (no LLM spend)", async ({ request }) => {
  const voices = await getData(request, "/api/voice/voices");
  test.skip(voices.configured, "key present — fail-soft path not applicable");
  const res = await request.post("/api/generate/podcast", {
    headers: AUTH_HEADERS,
    data: { prompt: "test topic", minutes: 1 },
  });
  const events = parseSSE(await res.text());
  const err = events.find((e) => e.type === "error");
  expect(err?.message).toContain("voice not configured");
});

test("workflow: create -> run chain (search -> doc) -> steps + artifact", async ({
  request,
}) => {
  const wf = await postData(request, "/api/workflows", {
    name: `Test chain ${Date.now()}`,
    graph: {
      nodes: [
        {
          id: "s1",
          type: "search",
          config: { query: "what is photosynthesis", num_results: 3 },
        },
        {
          id: "s2",
          type: "generate",
          config: {
            generator: "doc",
            input: {
              prompt: "One short paragraph summarizing: {{previous}}",
              length: "short",
              model: TEST_MODEL,
            },
          },
        },
      ],
      edges: [{ from: "s1", to: "s2" }],
    },
  });
  expect(wf.id).toBeTruthy();

  const run = await postData(request, `/api/workflows/${wf.id}/run`, {});
  let detail: any;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3_000));
    detail = await getData(request, `/api/workflows/runs/${run.id}`);
    if (["completed", "failed", "cancelled"].includes(detail.status)) break;
  }
  expect(detail.status, JSON.stringify(detail.steps)).toBe("completed");
  expect(detail.steps.length).toBe(2);
  expect(detail.steps.every((s: any) => s.status === "ok")).toBe(true);
  const gen = detail.steps.find((s: any) => s.node_type === "generate");
  const out = typeof gen.output === "string" ? JSON.parse(gen.output) : gen.output;
  expect(out.artifact_id).toBeTruthy();

  await request.delete(`/api/artifacts/${out.artifact_id}`, { headers: AUTH_HEADERS });
  await request.delete(`/api/workflows/${wf.id}`, { headers: AUTH_HEADERS });
});

test("workflow: unattended agent_task with a vague goal completes (no ask_user suspend)", async ({
  request,
}) => {
  test.setTimeout(300_000);
  // Regression: a workflow agent_task used to call ask_user on an ambiguous
  // goal and suspend, which the runner reported as "Agent run suspended for
  // user input - not supported inside workflows". Unattended runs now drop
  // ask_user and assume-and-proceed, so an ambiguous goal completes instead.
  const wf = await postData(request, "/api/workflows", {
    name: `Unattended agent ${Date.now()}`,
    graph: {
      nodes: [
        {
          id: "a1",
          type: "agent_task",
          config: {
            goal: "Summarize the most important updates and decisions from the past week.",
            budget_usd: 0.4,
            max_iterations: 8,
          },
        },
      ],
      edges: [],
    },
  });
  expect(wf.id).toBeTruthy();

  const run = await postData(request, `/api/workflows/${wf.id}/run`, {});
  let detail: any;
  const deadline = Date.now() + 280_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 4_000));
    detail = await getData(request, `/api/workflows/runs/${run.id}`);
    if (["completed", "failed", "cancelled"].includes(detail.status)) break;
  }
  // The whole point of the fix: it must never fail by suspending for input.
  expect(detail.error ?? "").not.toContain("suspended for user input");
  expect(detail.status, JSON.stringify({ status: detail.status, error: detail.error })).toBe(
    "completed",
  );
  const step = detail.steps.find((s: any) => s.node_type === "agent_task");
  expect(step?.status).toBe("ok");

  await request.delete(`/api/workflows/${wf.id}`, { headers: AUTH_HEADERS });
});

test("workflow validation: bad cron rejected, cycle rejected", async ({ request }) => {
  const badCron = await request.post("/api/workflows", {
    headers: AUTH_HEADERS,
    data: { name: "x", schedule: "not a cron" },
  });
  expect(badCron.status()).toBe(400);

  const wf = await postData(request, "/api/workflows", {
    name: `Cycle ${Date.now()}`,
    graph: {
      nodes: [
        { id: "a", type: "search", config: { query: "x" } },
        { id: "b", type: "read_url", config: { url: "https://example.com" } },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    },
  });
  // Cycle may be rejected at create or fail the run — accept either contract.
  const run = await request.post(`/api/workflows/${wf.id}/run`, {
    headers: AUTH_HEADERS,
    data: {},
  });
  if (run.ok()) {
    const runId = (await run.json()).data.id;
    let detail: any;
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2_000));
      detail = await getData(request, `/api/workflows/runs/${runId}`);
      if (["completed", "failed", "cancelled"].includes(detail.status)) break;
    }
    expect(detail.status).toBe("failed");
  }
  await request.delete(`/api/workflows/${wf.id}`, { headers: AUTH_HEADERS });
});
