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

test("ai developer: generates a self-contained webpage artifact", async ({ request }) => {
  const res = await request.post("/api/generate/webapp", {
    headers: AUTH_HEADERS,
    data: { prompt: "A minimal counter: a number and + / - buttons.", style: "minimal" },
  });
  expect(res.ok()).toBe(true);
  const artifact = (await res.text())
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
  expect(artifact, "expected a webpage artifact").toBeTruthy();
  expect(artifact.kind).toBe("webpage");

  const detail = await getData(request, `/api/artifacts/${artifact.id}`);
  const html: string = detail.content.html;
  expect(html.toLowerCase()).toContain("<!doctype html");
  expect(html).toContain("<script");
  // Self-contained: no external http(s) resource references.
  expect(/(src|href)=["']https?:/.test(html)).toBe(false);

  await request.delete(`/api/artifacts/${artifact.id}`, { headers: AUTH_HEADERS });
});

test("agentbase from-file: CSV -> typed system with computed tiles", async ({ request }) => {
  const csv =
    'Name,Amount,Stage,Signed\n"Acme, Inc.",1200.50,Won,2026-01-05\nBeta LLC,900,Lost,2026-02-11\nGamma Co,3400,Won,2026-03-02\n';
  const res = await request.post("/api/agentbase/systems/from-file", {
    headers: AUTH_HEADERS,
    multipart: {
      name: "Deals",
      file: { name: "deals.csv", mimeType: "text/csv", buffer: Buffer.from(csv) },
    },
  });
  expect(res.ok()).toBe(true);
  const system = (await res.json()).data;

  const detail = await getData(request, `/api/agentbase/systems/${system.id}`);
  const table = detail.tables[0];
  expect(table.records.length).toBe(3);
  const types = Object.fromEntries(table.columns.map((c: any) => [c.key, c.type]));
  expect(types.amount).toBe("number");
  expect(types.signed).toBe("date");
  const stat = detail.tiles.find((t: any) => t.kind === "stat");
  expect(typeof stat.value).toBe("number");

  await request.delete(`/api/agentbase/systems/${system.id}`, { headers: AUTH_HEADERS });
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
