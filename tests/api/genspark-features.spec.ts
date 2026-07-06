import { test, expect } from "@playwright/test";
import { AUTH_HEADERS, getData, postData } from "./_helpers";

test.describe.configure({ timeout: 180_000 });

test("skills: seeded community skills, filters, create/run/delete", async ({ request }) => {
  const community = await getData(request, "/api/skills?tab=community");
  expect(community.skills.length).toBeGreaterThanOrEqual(20);

  // Output filter narrows results.
  const docs = await getData(request, "/api/skills?tab=community&output=doc");
  expect(docs.skills.length).toBeGreaterThan(0);
  expect(docs.skills.every((s: any) => s.output === "doc")).toBe(true);

  // Create a personal skill, run it (resolves the seed), then delete.
  const mine = await postData(request, "/api/skills", {
    name: "My test skill",
    description: "x",
    role: "General",
    output: "chat",
    target: "chat",
    prompt_template: "Summarize {{input}} in three bullets.",
  });
  expect(mine.id).toBeTruthy();
  const run = await postData(request, `/api/skills/${mine.id}/run`, { input: "the news" });
  expect(run.prompt).toContain("the news");
  const mineList = await getData(request, "/api/skills?tab=mine");
  expect(mineList.skills.some((s: any) => s.id === mine.id)).toBe(true);
  const del = await request.delete(`/api/skills/${mine.id}`, { headers: AUTH_HEADERS });
  expect(del.ok()).toBe(true);
});

test("workflow NL generate builds a valid graph; template clone works", async ({
  request,
}) => {
  const gen = await postData(request, "/api/workflows/generate", {
    prompt:
      "Search for today's top climate-tech headlines and write a one-paragraph brief.",
  });
  expect(gen.id).toBeTruthy();
  const graph = typeof gen.graph === "string" ? JSON.parse(gen.graph) : gen.graph;
  expect(graph.nodes.length).toBeGreaterThanOrEqual(1);
  expect(graph.nodes.length).toBeLessThanOrEqual(6);
  const kinds = graph.nodes.map((n: any) => n.type);
  expect(kinds.every((k: string) => ["agent_task", "generate", "search", "read_url"].includes(k))).toBe(
    true
  );
  await request.delete(`/api/workflows/${gen.id}`, { headers: AUTH_HEADERS });

  const templates = await getData(request, "/api/workflows/templates");
  expect(templates.templates.length).toBeGreaterThanOrEqual(6);
  const clone = await postData(
    request,
    `/api/workflows/templates/${templates.templates[0].id}/use`
  );
  expect(clone.id).toBeTruthy();
  expect(clone.enabled).toBe(0);
  await request.delete(`/api/workflows/${clone.id}`, { headers: AUTH_HEADERS });
});

test("agentbase: template -> system with computed dashboard tiles + add record", async ({
  request,
}) => {
  const templates = await getData(request, "/api/agentbase/templates");
  expect(templates.templates.length).toBeGreaterThanOrEqual(8);
  const crm = templates.templates.find((t: any) => /crm/i.test(t.name)) ?? templates.templates[0];

  const system = await postData(request, "/api/agentbase/systems", { from_template: crm.id });
  expect(system.id).toBeTruthy();

  const detail = await getData(request, `/api/agentbase/systems/${system.id}`);
  expect(detail.tables.length).toBeGreaterThanOrEqual(1);
  expect(detail.tables[0].records.length).toBeGreaterThan(0);
  expect(detail.tiles.length).toBeGreaterThanOrEqual(1);
  // At least one stat tile has a number and one chart tile has points.
  const stat = detail.tiles.find((t: any) => t.kind === "stat");
  expect(typeof stat.value).toBe("number");
  const chart = detail.tiles.find((t: any) => t.kind === "bar" || t.kind === "donut");
  if (chart) expect(Array.isArray(chart.points)).toBe(true);

  // Add a record → row count increments.
  const table = detail.tables[0];
  const before = table.records.length;
  const firstCol = table.columns[0].key;
  const added = await postData(
    request,
    `/api/agentbase/systems/${system.id}/tables/${table.id}/records`,
    { data: { [firstCol]: "New test row" } }
  );
  expect(added.id).toBeTruthy();
  const after = await getData(request, `/api/agentbase/systems/${system.id}`);
  expect(after.tables[0].records.length).toBe(before + 1);

  await request.delete(`/api/agentbase/systems/${system.id}`, { headers: AUTH_HEADERS });
});
