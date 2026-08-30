# AGENTS.md

pi extension package: Tencent CodeBuddy provider + custom footer, for the pi coding agent.

## Commands

- Done = `npm run typecheck` and `npm run lint` both pass — run both after every TypeScript edit. `npm run lint:fix` settles formatting; never hand-format (Biome owns `extensions/**` and `scripts/**`).
- `npm run footer-preview [cols]` renders the footer line in isolation (`PI_THEME=light` for the light theme), no live session needed.

## Pointers

- `CONTEXT.md` — project glossary (上下文用量, coding plan, 配额窗口, 窗口重置); use its terms in comments, docs, and UI strings.
- `extensions/warp-notify/` — Warp notifications, file layout mirrors upstream rpiv-warp (`protocol.ts` detection, `payload.ts` builders, `warp-notify.ts` OSC transport, `title-spinner.ts`, `config.ts`, `index.ts` registration + state machine). Run/block state is refcounted and shared across parent + subagent instances (ESM caching); read the state machine in `index.ts`'s header before adding or changing lifecycle handlers.
- `extensions/tc-footer.ts` — status-line rendering. `scripts/footer-preview.mjs` mirrors its render functions; a render-logic change updates the mirrors in the same change, then re-runs `footer-preview`.
- `extensions/tencent-copilot.ts` — provider + model catalog. Models are maintained as the `SNAPSHOT` tuple array; adding a model is one line.

## Edit discipline

- Exact-match edits copy from a fresh read of the target region.
- Box-drawing characters or irregular alignment whitespace: prefer a python anchor-based replacement over exact-match editing.
- `package.json` uses tab indentation; edit it JSON-aware (e.g. python `json`), not with string surgery.
- Before importing an unfamiliar API, verify its exports:
  `node -e "import('pkg').then(m=>console.log(Object.keys(m)))"`
