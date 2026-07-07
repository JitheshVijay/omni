import { test, expect } from "@playwright/test";
import { AUTH_HEADERS, getData, parseSSE } from "./_helpers";

// The full-stack App Builder. The live E2B sandbox path is billed and needs
// E2B_API_KEY, so this test only exercises the codegen half via the fail-soft
// path (no key -> status 'no_sandbox' with the generated project saved). If a
// key IS configured we skip, to avoid provisioning a real (paid) sandbox.
test("full-stack builder: codegen yields a runnable Vite+React+Express project", async ({
  request,
}) => {
  test.setTimeout(120_000);
  const settings = await getData(request, "/api/settings");
  test.skip(settings.keys?.e2b?.configured === true, "E2B configured — skip to avoid a paid sandbox");

  const res = await request.post("/api/fullstack/build", {
    headers: AUTH_HEADERS,
    data: { prompt: "A notes app: create, edit, and delete notes, persisted to the database." },
  });
  expect(res.ok()).toBeTruthy();

  const events = parseSSE(await res.text());
  const created = events.find((e) => e.type === "created");
  expect(created?.id).toBeTruthy();
  const done = events.find((e) => e.type === "project");
  expect(done?.project?.status).toBe("no_sandbox");

  const detail = await getData(request, `/api/fullstack/projects/${created!.id}`);
  const paths = detail.files.map((f: { path: string }) => f.path);
  for (const p of ["package.json", "vite.config.js", "index.html", "src/App.jsx", "server/index.js"]) {
    expect(paths, JSON.stringify(paths)).toContain(p);
  }
  const server = detail.files.find((f: { path: string }) => f.path === "server/index.js").content;
  expect(server).toContain("express");
  expect(server).toContain("better-sqlite3");
});
