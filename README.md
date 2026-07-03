# Omni

An all-in-one **local** AI workspace: multi-model chat (via OpenRouter), an autonomous
Super Agent, project Hubs with persistent memory, an AI Drive, and a growing suite of
content generators (docs, slides, sheets, images, audio) — single-user, fully offline
data (SQLite + local filesystem).

## Quick start

```bash
cp .env.example .env        # fill in OPENROUTER_API_KEY (required)
npm install
npm run dev                 # API on :4100, web on :5175
```

Data lives at `~/.omni/` (`omni.db`, `drive/`, `artifacts/`, `runs/`). Override with
`OMNI_DATA_DIR`.

## Keys

| Env var | Required | Unlocks |
|---|---|---|
| `OPENROUTER_API_KEY` | yes | all chat models, embeddings, image gen |
| `EXA_API_KEY` | no | high-quality agent web search (falls back to `:online` models) |
| `ELEVENLABS_API_KEY` | no | dictation, read-aloud, podcast voices |
| `LLAMAPARSE_API_KEY` | no | high-quality PDF/office extraction (falls back to pdf-parse) |

## Workspace layout

- `apps/api` — Fastify API (`@omni/api`)
- `apps/web` — Vite + React SPA (`@omni/web`)
- `packages/sdk` — shared LLM/data/content layer (`@omni/sdk`)
- `packages/env-config` — Zod-validated env (`@omni/env-config`)
- `migrations/` — raw SQL, applied automatically at API boot

## Scripts

- `npm run dev` / `build` / `lint` / `typecheck` / `test` — via turbo
- `npm run test:api` — Playwright API integration suite (server must be running)
- `npm run db:migrate` — apply migrations without booting the API
