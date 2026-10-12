# KG Studio web UI

React 19 + Vite + TypeScript. See the [main README](../../README.md) for setup.

```bash
npm run dev     # http://localhost:5173, proxies /api to the backend on :8000
npm run build   # type-check and build into dist/ (served by the backend)
npm run lint
```

- `src/App.tsx`: app shell (sidebar, pipeline rail, welcome screen)
- `src/usePipeline.ts`: reduces the backend's NDJSON event stream into UI state
- `src/components/StepViews.tsx`: one view per pipeline step
- `src/components/GraphCanvas.tsx`, `graphStyle.ts`: force-directed graph and its colours
- `src/index.css`: design tokens and all component styles

LLM settings are intentionally not part of the UI; they live in the repo-root `.env`.
