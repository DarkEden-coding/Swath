# Project architecture

Compact overview. For deeper docs, see `docs/architecture/README.md` and `docs/features/README.md`.

This project is a local Tauri app with three main layers:

- `src/shared/` — types and IPC contracts shared by renderer and Rust.
- `src/renderer/` — React UI, stores, actions, and browser/Tauri adapters.
- `src-tauri/` — Rust backend for config, PTY terminals, dialogs, clipboard, and git.

## Folder map

### `src/shared/`
Shared contracts.

- `types/` — `AppConfig`, `Workspace`, `WorkspaceView`, `PaneLeaf`, `PaneKind`, settings, terminal, and workspace models.
- `ipc/` — channel names and request validators (`gitRpc` is the main custom RPC surface).
- `memoryLimits.ts` — shared limits for terminal scrollback/replay and git output.

### `src/renderer/`
React app.

- `main.tsx` — bootstraps React, loads CSS, and attaches the browser/Tauri adapter.
- `viteBrowserTpm.ts` — creates `window.swath` for Tauri and for Vite-only dev.
- `App.tsx` — root shell: loads config, listens for menu/app commands, renders sidebar/workspace/status/settings.
- `app/` — thin app-level actions and command routing.
- `state/` — Zustand stores for persisted config and transient UI state.
- `domain/` — pure config/layout mutations (workspaces, views, panes, settings).
- `services/` — wrappers around `window.swath.*` APIs.
- `features/` — UI features (shell layout, panes, tabs, settings, terminal, git manager).

### `src-tauri/`
Native backend.

- `src/config.rs` — SQLite persistence and config normalization.
- `src/terminal.rs` — PTY session lifecycle, replay buffer, attach/restart, and process exit detection.
- `src/git.rs` — git subprocess runner and git RPC implementation.
- `src/platform.rs` — dialogs, clipboard, open-external, and platform helpers.
- `src/menu.rs` — native menu items and app-command emission.
- `src/commands.rs` — Tauri command entry points.
- `src/types.rs` — Rust equivalents of shared types.
- `src/lib.rs` / `src/main.rs` — app startup.

## Runtime flow

1. `src/renderer/main.tsx` calls `attachSwathAdapterIfMissing()` and renders `<App />`.
2. `App.tsx` hydrates config from `window.swath.config.load()` via `useAppBootstrap()`.
3. The active workspace is rendered inside `TerminalWorkspace`.
4. `ViewTabBar` manages top-level workspace views ("tabs").
5. `LayoutRenderer` recursively renders the split tree.
6. Each `PaneLeaf` is resolved through `paneRegistry` to a pane component.
7. Pane-specific components use app actions and `window.swath.*` services for side effects.

## Important files and what they do

### Root/UI shell

- `src/renderer/App.tsx` — overall app layout, sidebar width/collapse, menu command handling, settings modal.
- `src/renderer/features/shell/components/Sidebar.tsx` — project list, rename/remove/copy-path, drag reorder, add project.
- `src/renderer/features/shell/components/TerminalWorkspace.tsx` — active workspace surface and empty state.
- `src/renderer/features/shell/components/StatusBar.tsx` — active workspace/view summary and settings shortcut.
- `src/renderer/features/shell/components/EmptyState.tsx` — onboarding when no project exists.

### View/tab chrome

- `src/renderer/features/views/components/ViewTabBar.tsx` — workspace view tabs, rename, reorder, new-tab menu.
- `src/renderer/features/panes/components/PaneFrame.tsx` — common pane border + toolbar wrapper.
- `src/renderer/features/panes/components/PaneToolbar.tsx` — split/close buttons and split-type picker.
- `src/renderer/features/panes/components/LayoutRenderer.tsx` — recursive split layout renderer.

### Tab registry

- `src/shared/types/tabTypes.ts` — the source of truth for allowed `PaneKind` values.
- `src/renderer/features/tabTypes/types.ts` — `TabTypeRegistration` contract.
- `src/renderer/features/tabTypes/registry.ts` — maps kind -> registration.
- `src/renderer/features/panes/paneRegistry.ts` — derived registry used by the renderer.

### Domain actions

- `src/renderer/domain/workspaces/workspaceActions.ts` — add/remove/select/rename/reorder projects.
- `src/renderer/domain/views/viewActions.ts` — add/close/select/rename/reorder workspace views.
- `src/renderer/domain/panes/paneActions.ts` — split/close panes, set active pane, ratio, title, cwd.
- `src/renderer/domain/layout/layoutTree.ts` — tree utilities: create, split, close, find, collect, clamp ratios.
- `src/renderer/domain/settings/settingsActions.ts` — update app settings and shell profiles.

### Services and stores

- `src/renderer/services/configClient.ts` — config load/save.
- `src/renderer/services/dialogClient.ts` — folder picker and confirm dialog.
- `src/renderer/services/terminalClient.ts` — PTY create/write/resize/attach/restart/replay/busy.
- `src/renderer/services/gitClient.ts` — git RPC wrapper.
- `src/renderer/state/configStore.ts` — persisted `AppConfig` hydration/save.
- `src/renderer/state/uiStore.ts` — transient UI state (active pane, sidebar, settings modal).

### Native side

- `src-tauri/src/config.rs` — reads/writes `swath.sqlite3`, migrates legacy DB path, fills defaults.
- `src-tauri/src/terminal.rs` — keeps terminal sessions alive, streams PTY data, records replay, checks busy state.
- `src-tauri/src/git.rs` — shells out to `git` and returns structured JSON.
- `src-tauri/src/platform.rs` — folder dialogs, confirms, clipboard, and external URLs.
- `src-tauri/src/menu.rs` — emits `app:command` events for menu actions.

## How tab types work

A tab/pane kind is a string literal `PaneKind`.

Current kinds live in `src/shared/types/tabTypes.ts`:

- `terminal`
- `gitManager`

The renderer uses a registration object for each kind:

```ts
export interface TabTypeRegistration {
  kind: PaneKind;
  label: string;
  Component: React component;
  createPaneMeta: (settings, cwd?) => pane defaults;
  createView: (title, cwd, settings) => WorkspaceView;
  isBusy?: (paneId) => Promise<boolean>;
  closePane?: (paneId) => void;
}
```

Where it is used:

- `ViewTabBar` uses `getTabTypes()` for the new-tab picker.
- `PaneToolbar` uses `getTabTypes()` for split-to-kind.
- `LayoutRenderer` uses `paneRegistry` to choose the pane component.
- `appActions.createView()` and `appActions.splitPane()` use the registration to create pane/view metadata.

### Current tab implementations

- `terminal` — PTY-backed xterm pane. `terminalTabType.ts` supplies default shell/env metadata, `isBusy`, and `closePane` cleanup.
- `gitManager` — source-control pane. `gitManagerTabType.ts` supplies default title/CWD metadata and renders the Git UI backed by `gitClient`.

## Adding a new tab

1. Add the literal to `src/shared/types/tabTypes.ts`.
2. Create `src/renderer/features/tabTypes/<name>/` with:
   - pane component
   - `create<View|Pane>Meta` helpers
   - `TabTypeRegistration`
3. Register it in `src/renderer/features/tabTypes/registry.ts`.
4. If the pane needs backend privileges, add one IPC/RPC surface for that domain.
5. If the pane is busy/owns resources, implement `isBusy` and/or `closePane`.
6. Verify split/new-tab menus pick it up automatically.

## If the new tab needs native/backend work

Prefer one stable RPC surface per domain.

Example pattern used by Git:

- shared request union in `src/shared/ipc/gitRpc.ts`
- renderer wrapper in `src/renderer/services/gitClient.ts`
- Tauri command in `src-tauri/src/commands.rs`
- actual backend logic in `src-tauri/src/git.rs`
- dev adapter in `src/renderer/viteBrowserTpm.ts`

If you add a new domain API, update all four places above so Vite dev and Tauri both work.

## Maintenance checklist

- Run `npm run typecheck` after touching shared types, registries, or actions.
- Run `npm run test:unit` for layout/terminal/domain changes.
- Run `npm test` if clipboard/paste behavior changes.
- Update both TS and Rust models when config shape changes.
- Keep `PaneKind`, tab registry, and split/new-tab menus in sync.
- Preserve `kind` when creating split panes and new views.
- Keep side effects in services/app actions; keep domain actions mostly pure.

## Persistence model

`AppConfig` stores:

- workspaces and their order
- active workspace
- views per workspace
- split layout trees
- active view / active pane
- settings and shell profiles
- global env vars

Runtime-only data that is not restored:

- live PTY process trees
- terminal scrollback in full detail
- current process state after app restart

The backend restores layout shape and re-attaches terminal sessions when possible, but the persistent source of truth is the config document in SQLite.

## Conventions

- Use `src/shared/` for anything the renderer and Rust both need to agree on.
- Use `src/renderer/domain/` for pure state transformations.
- Use `src/renderer/services/` for `window.swath` calls.
- Use `src/renderer/features/` for UI and feature-specific behavior.
- Keep new tab logic inside its tab folder and registry entry.
- Keep runtime IDs generated with `createId()`.
- Prefer shared helpers over ad-hoc copies for pane metadata, split trees, and config updates.