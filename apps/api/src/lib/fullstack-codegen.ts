// Full-stack project codegen for the App Builder. To keep generated apps
// reliably runnable, the TOOLCHAIN is fixed here (a Vite + React frontend and an
// Express + better-sqlite3 API, wired so Vite proxies /api to the server) and
// the LLM only fills in the app logic (src/App.jsx + components, server/index.js).
// So the model never has to invent a working build config — it just writes the
// feature code into a known-good skeleton.
import { callLLMJSON, MODELS } from "@omni/sdk";
import type { ProjectFile } from "./e2b.js";

export interface GeneratedProject {
  name: string;
  summary: string;
  files: ProjectFile[];
  installCmd: string;
  devCmd: string;
  previewPort: number;
}

export const PREVIEW_PORT = 5173;
const API_PORT = 3001;

// ── fixed scaffold: guaranteed-runnable toolchain, written verbatim ──
const SCAFFOLD: ProjectFile[] = [
  {
    path: "package.json",
    content: JSON.stringify(
      {
        name: "omni-app",
        private: true,
        type: "module",
        scripts: {
          dev: `concurrently -k -n api,web "node server/index.js" "vite --host --port ${PREVIEW_PORT}"`,
          build: "vite build",
        },
        dependencies: {
          express: "^4.19.2",
          "better-sqlite3": "^11.3.0",
          react: "^18.3.1",
          "react-dom": "^18.3.1",
        },
        devDependencies: {
          vite: "^5.4.8",
          "@vitejs/plugin-react": "^4.3.1",
          concurrently: "^9.0.1",
        },
      },
      null,
      2,
    ),
  },
  {
    path: "vite.config.js",
    content: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// host:true + allowedHosts:true so the public E2B preview host can reach the
// dev server; /api is proxied to the Express server so the app is same-origin.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: ${PREVIEW_PORT},
    allowedHosts: true,
    proxy: { "/api": "http://localhost:${API_PORT}" },
  },
});
`,
  },
  {
    path: "index.html",
    content: `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>App</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.jsx"></script>
  </body>
</html>
`,
  },
  {
    path: "src/main.jsx",
    content: `import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
`,
  },
  {
    path: "src/index.css",
    content: `:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; }
`,
  },
];

const SCAFFOLD_PATHS = new Set(SCAFFOLD.map((f) => f.path));

const SYSTEM = [
  "You are an elite full-stack engineer. You write the APP CODE for a project whose toolchain is already set up: a Vite + React 18 frontend and an Express + better-sqlite3 backend, with Vite proxying /api to the Express server on port " + API_PORT + ".",
  "",
  "The following files ALREADY EXIST and you MUST NOT output them: package.json, vite.config.js, index.html, src/main.jsx, src/index.css.",
  "",
  "Write ONLY these files:",
  "- src/App.jsx (required): the root React component. You may add more components/CSS under src/ and import them.",
  "- server/index.js (required): an Express app that listens on port " + API_PORT + ", uses better-sqlite3 (new Database('data.db')) for persistence, creates its tables on startup if missing, and exposes JSON REST endpoints under /api/*. Enable express.json(). Do NOT serve static files — Vite handles the frontend.",
  "",
  "RULES:",
  "- The frontend talks to the backend with fetch('/api/...') (same-origin via the proxy). Never hardcode a host or port.",
  "- Use ES modules (import/export) everywhere; package.json has \"type\":\"module\".",
  "- Make it genuinely functional and persistent: real routes, real DB reads/writes, real state and interactivity — not a mockup. Handle empty/error states.",
  "- Only use the dependencies already declared (express, better-sqlite3, react, react-dom). No other npm packages, no external network calls, no CDNs.",
  "- Do not invent secrets or credentials.",
].join("\n");

interface RawGen {
  name?: string;
  summary?: string;
  files?: { path?: string; content?: string }[];
}

/** Generate a runnable full-stack project from a natural-language prompt. */
export async function generateFullstackProject(prompt: string): Promise<GeneratedProject> {
  const raw = await callLLMJSON<RawGen>({
    system: SYSTEM,
    prompt:
      `Build this app: ${prompt}\n\n` +
      'Respond with JSON: {"name": string (short, kebab-friendly), "summary": string (one sentence), "files": [{"path": string, "content": string}]}. ' +
      "Include at least src/App.jsx and server/index.js.",
    model: MODELS.agent,
    maxTokens: 16000,
  });

  const llmFiles = (raw.files ?? [])
    .filter((f): f is { path: string; content: string } =>
      typeof f?.path === "string" && typeof f?.content === "string" && f.path.trim().length > 0,
    )
    .map((f) => ({ path: f.path.replace(/^\/+/, "").trim(), content: f.content }))
    // The scaffold is authoritative — drop any attempt to overwrite the toolchain.
    .filter((f) => !SCAFFOLD_PATHS.has(f.path));

  const hasApp = llmFiles.some((f) => f.path === "src/App.jsx");
  const hasServer = llmFiles.some((f) => f.path === "server/index.js");
  if (!hasApp || !hasServer) {
    throw new Error(
      `Codegen incomplete: missing ${!hasApp ? "src/App.jsx" : ""}${!hasApp && !hasServer ? " and " : ""}${!hasServer ? "server/index.js" : ""}.`,
    );
  }

  return {
    name: (raw.name || "omni-app").replace(/[^a-z0-9-]/gi, "-").toLowerCase().slice(0, 40) || "omni-app",
    summary: raw.summary || prompt.slice(0, 140),
    files: [...SCAFFOLD, ...llmFiles],
    installCmd: "npm install",
    devCmd: "npm run dev",
    previewPort: PREVIEW_PORT,
  };
}
