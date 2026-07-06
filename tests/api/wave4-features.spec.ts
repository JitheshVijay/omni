import { test, expect } from "@playwright/test";
import { AUTH_HEADERS, getData, parseSSE, postData } from "./_helpers";

test.describe.configure({ timeout: 300_000 });

test("meeting notes: transcript -> structured doc with action items", async ({ request }) => {
  const res = await request.post("/api/generate/meeting", {
    headers: AUTH_HEADERS,
    data: {
      transcript:
        "Alex: We ship the billing fix Friday. Sam: I'll do the Stripe webhook. " +
        "Alex: Jordan handles retry logic. We postponed the redesign to Q4. " +
        "Open question: do we need SOC2 first? Sam: I'll ask legal.",
    },
  });
  expect(res.ok()).toBe(true);
  const artifact = parseSSE(await res.text()).find((e) => e.type === "artifact")?.artifact;
  expect(artifact, "expected a doc artifact").toBeTruthy();
  expect(artifact.kind).toBe("doc");
  expect(artifact.meta?.subtype).toBe("meeting");
  const detail = await getData(request, `/api/artifacts/${artifact.id}`);
  expect(detail.content.markdown.toLowerCase()).toContain("action items");
  await request.delete(`/api/artifacts/${artifact.id}`, { headers: AUTH_HEADERS });
});

test("agent presets: seeded, launch creates an agent run", async ({ request }) => {
  const community = await getData(request, "/api/agent-presets?tab=community");
  expect(community.presets.length).toBeGreaterThanOrEqual(8);

  const launch = await postData(request, "/api/agent-presets/builtin:deep-research/launch", {
    input: "the history of the abacus",
  });
  expect(launch.run_id).toBeTruthy();
  const run = await getData(request, `/api/agent/runs/${launch.run_id}`);
  expect(run.goal).toContain("abacus");
  // Cancel to avoid a long unrelated run.
  await request.post(`/api/agent/runs/${launch.run_id}/cancel`, { headers: AUTH_HEADERS });

  // Create + delete a personal preset.
  const mine = await postData(request, "/api/agent-presets", {
    name: "Test preset",
    description: "x",
    category: "Research",
    goal_template: "Research {{input}} and summarize.",
  });
  expect(mine.id).toBeTruthy();
  const del = await request.delete(`/api/agent-presets/${mine.id}`, { headers: AUTH_HEADERS });
  expect(del.ok()).toBe(true);
});

test("deep research: multi-search produces a cited report doc", async ({ request }) => {
  const res = await request.post("/api/research", {
    headers: AUTH_HEADERS,
    data: { question: "What is a bloom filter and when is it useful?" },
  });
  expect(res.ok()).toBe(true);
  const events = parseSSE(await res.text());
  const statuses = events.filter((e) => e.type === "status").map((e) => e.label);
  expect(statuses.some((l) => /searching/i.test(l))).toBe(true);
  const artifact = events.find((e) => e.type === "artifact")?.artifact;
  expect(artifact, JSON.stringify(statuses)).toBeTruthy();
  expect(artifact.kind).toBe("doc");
  expect(artifact.meta?.subtype).toBe("research");

  const detail = await getData(request, `/api/artifacts/${artifact.id}`);
  expect(detail.content.markdown.length).toBeGreaterThan(300);
  expect(detail.content.sources.length).toBeGreaterThanOrEqual(1);
  await request.delete(`/api/artifacts/${artifact.id}`, { headers: AUTH_HEADERS });
});
