# AGENTS.md

pi extension package: Tencent CodeBuddy provider + custom footer, for the pi coding agent.

## Commands

```bash
npm run typecheck       # tsc --noEmit, run after every TS edit
npm run lint            # biome check .
npm run lint:fix        # biome check --write . (auto-fix formatting)
npm run footer-preview  # render tc-footer layout in terminal (no live session needed)
npm run footer-preview 60                # preview at 60 columns
PI_THEME=light npm run footer-preview    # preview with light theme
```

After editing any TypeScript file, run `typecheck` and `lint` before considering the change done.

## Formatting

Biome (`biome.json`) owns formatting and linting for `extensions/**` and `scripts/**`:

- Tabs for indentation, double quotes, no semicolons in `.ts` (semicolons kept in `.mjs`).
- Never hand-format; run `npm run lint:fix` instead.
- `package.json` is formatted by Biome too (tabs). Use a JSON-aware edit (e.g. python `json`) and re-run `lint:fix`.

## Warp notification rules

`extensions/warp-notify.ts` ports @juicesharp/rpiv-warp's OSC 777 notifications with one deliberate divergence — the run/block state is **refcounted** (`activeRuns`, `blockedCalls`), not boolean:

- Subagent sessions bind this same extension (pi-subagents `extensions: true`), and ESM caching shares this module's state across parent + child instances. A child's `agent_end` must therefore only decrement the counter, never stop the spinner/heartbeat or emit a `stop` toast.
- "Outermost" is a settable role (`outerSettled`), not just the 0→1 transition: background subagents (`run_in_background`) can outlive the run that spawned them, so after the outer run settles the next `agent_start` becomes a NEW outer (re-announces, takes over the heartbeat) even though the counter never reached zero; a non-outer end that drops the counter to zero stops the spinner but emits no stop toast.
- All terminal writes are silent-swallow, all timers `unref()`ed, and detection (`TERM_PROGRAM` + `WARP_CLI_AGENT_PROTOCOL_VERSION` + broken-build gate) happens before any handler registration — outside Warp the feature costs nothing.
- Timers/heartbeat live on module state too; any new lifecycle handler must keep the invariants above (see the file header for the full state machine).

## Footer rendering rules

`extensions/tc-footer.ts` renders one ANSI-safe line:

```
<cwd>  <pct>% <10-cell bar>  ⏳5h <pct>% <5-cell bar> ↻<countdown>  <model-id> ⚡<thinking> (<git-branch>)
```

- cwd: `~`-relative inside `$HOME`, otherwise the last two path segments (`user/repo`).
- Context percent: rounded to integer, computed against the effective window min(contextWindow, 450k); color thresholds are dynamic — small windows go red at pi's auto-compaction trigger, 450k-capped windows at 65%; yellow is half the red line.
- Plan window (⏳5h): GLM coding plan (`zai-coding-cn`) 5h quota window, polled every 5 min from bigmodel.cn with the key resolved via `modelRegistry.getApiKeyForProvider`; shown only while that provider is active; blue (mdLink) bar (distinct from the green context bar), warning ≥70%, error ≥90%, snapshots older than 10 min render dim; dropped before the model id on narrow terminals.
- Model id: default foreground. Branch: dim. Thinking: accent. Cwd: dim.
- `scripts/footer-preview.mjs` mirrors this logic function-by-function (`formatCwd`, `contextBar`, `renderLine`). When changing render logic in `tc-footer.ts`, update the mirrors in the preview script and re-run it.

## Edit discipline

- Read the target region before using exact-match edits; file content must be copied, not recalled.
- For lines containing box-drawing characters or irregular alignment whitespace, prefer a python anchor-based replacement over exact-match editing.
- Keep edits small and independently verifiable.
- Verify package exports before importing unfamiliar APIs:
  `node -e "import('pkg').then(m=>console.log(Object.keys(m)))"`
