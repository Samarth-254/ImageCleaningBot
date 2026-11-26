# Architecture Decisions & Trade-offs

## 1. Frontend: React (Vite) + Tailwind in Plain JavaScript
- Chose Vite + React in plain JS (`/web/src/*.jsx`) rather than Next.js to keep the frontend lightweight, fast to build, and cleanly separated from the Express SSE/upload server.

## 2. Trigger.dev Config in Plain JavaScript
- `@trigger.dev/sdk/v3` supports `server/trigger.config.js` directly with `defineConfig` and `build.external: ['sharp']`, so **zero TypeScript** files exist anywhere in the codebase.

## 3. Local Disk Storage with `trigger.dev dev` (V1 Limitation)
- V1 stores immutable originals, downscaled previews, and edited outputs on local disk under `/server/storage` behind [storage.js](file:///d:/ImageCleaningBot/server/src/services/storage.js).
- Because `process-image` Trigger.dev tasks read originals and write edited outputs directly from `/server/storage`, V1 requires running `npx trigger.dev@latest dev` locally alongside the Express server so both share the local filesystem.
- **Cloud Deployment Path**: Replace the implementation inside `storage.js` with S3 or Cloudflare R2 (`PutObject` / `GetObject` / signed URLs). Neither the Express routes nor the Trigger.dev pipeline need structural changes.

## 4. Database & SQL Safety
- Uses Neon PostgreSQL via `pg` `Pool` (max 4 connections per process) and a single `db.query(text, params)` helper.
- Every query is parameterized (`$1, $2, ...`) and scoped by `dealer_id`.
- `npm run check:sql` statically scans `/server/src` for any SQL template-literal interpolation or string concatenation.
- SSE streaming uses a 500ms `id`-cursor poll on `messages` and `trace_events` instead of Postgres `LISTEN/NOTIFY`, because Neon's pooled connections do not support `LISTEN/NOTIFY`.

## 6. Checker Model (`gemini-3.8-flash`) & Thinking Level
- Verified via `models.list()` that `models/gemini-3.8-flash` supports `generateContent` directly, and supports `config.thinkingConfig: { thinkingLevel }` (`low` | `medium` | `high`, where `medium` is default).
- We call `ai.models.generateContent` with `thinkingConfig: { thinkingLevel: config.checkThinkingLevel }` (default `low`) and omit `temperature`, `topP`, and `topK`.
- If `CHECK_MODEL` fails with timeout, `429`, `5xx`, unavailable, or `invalid_json`, `generateStructuredJson` falls back to `CHECK_MODEL_FALLBACK` and logs `fallbackUsed: true` and `fallbackReason` in `trace_events`.

- **Verified in code & unit tests (`npm test`, `npm run check:sql`, `vite build`, `npm run smoke` mock)**:
  - `check:sql` passes with 0 violations.
  - SQL injection payload (`'; DROP TABLE jobs;--`) is safely parameterized and stored as plain text.
  - Path traversal in `storage.js` is rejected; originals are written with `{ flag: 'wx' }` so they cannot be overwritten.
  - Hard-stop guardrails in `applyAnalysisGuardrails()` force `passthrough` for documents, ID cards, VIN plates, and odometer readings even if the model suggests `edit`.
  - Non-vehicle images are rejected cleanly.
  - `editImage` `mock` adapter composites a visible `MOCK` badge and preserves dimensions.
  - Frontend builds cleanly with WhatsApp-style mobile layout, Before/After slider, Trace Panel, and Policy Editor.
- **Pending live environment keys**:
  - Live Gemini (`GEMINI_API_KEY`), Neon (`DATABASE_URL`), and Trigger.dev (`TRIGGER_SECRET_KEY`) smoke/e2e runs are wired and ready; they were skipped in this environment because those 3 secret keys are not set in `.env` yet.
