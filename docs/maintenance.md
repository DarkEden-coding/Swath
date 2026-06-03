# Maintenance guide

Use this when you are changing behavior across the project.

## Common change types

### Add a new tab type

- Add the kind to `src/shared/types/tabTypes.ts`
- Add the tab folder under `src/renderer/features/tabTypes/<name>/`
- Register it in `src/renderer/features/tabTypes/registry.ts`
- Verify split/new-tab menus pick it up automatically
- Update docs in `docs/features/tab-system.md`

### Change config shape

- Update `src/shared/types/config.ts` and related shared types
- Update `src-tauri/src/types.rs`
- Update `src-tauri/src/config.rs` normalization/defaults
- Update renderer code that reads/writes config

### Add a new native capability

- Prefer one RPC surface per domain
- Add shared request/response types
- Add renderer client wrapper
- Add Tauri command wiring
- Update the Vite browser adapter stub

### Change terminal behavior

- Check `TerminalPane.tsx`
- Check `terminalInputController.ts`
- Check `terminalClient.ts`
- Check `src-tauri/src/terminal.rs`

### Change git behavior

- Check `GitManagerPane.tsx`
- Check `gitClient.ts`
- Check `src/shared/ipc/gitRpc.ts`
- Check `src-tauri/src/git.rs`

## Good verification commands

- `npm run typecheck`
- `npm run test:unit`
- `npm test`
- `npm run dev` for full-stack manual checks

## Where to look first when debugging

- tab creation / split issues: `tabTypes`, `viewActions`, `paneActions`
- missing pane UI: `paneRegistry`
- terminal startup issues: `terminalClient`, `terminal.rs`
- config persistence issues: `configStore`, `config.rs`
- menu command issues: `menu.rs`, `App.tsx`, `commandRegistry.ts`

## Rule of thumb

Keep shared types and registry changes in sync. If a change affects a pane kind, it usually touches:

- shared types
- renderer registry
- pane/view actions
- docs