# Architecture overview

Swath is split into three layers:

- `src/shared/` — shared types and IPC contracts.
- `src/renderer/` — React UI, stores, domain actions, feature components, and browser/Tauri adapters.
- `src-tauri/` — Rust backend for config, PTY terminals, dialogs, clipboard, menu, and git.

In network deployments, `runtime::Core` owns the configured data directory and coordinates the
catalog/network runtime. A headless build runs the same core without Tauri or a display and is
used for the always-on catalog server; desktop builds add the Tauri shell and local UI. The
catalog server is a single durable authority in the current topology, while desktop devices are
clients/executors. `SWATH_DATA_DIR` must be absolute for headless operation.

## Runtime flow

1. `src/renderer/main.tsx` loads CSS, attaches `window.swath`, and renders `<App />`.
2. `App.tsx` hydrates config and listens for app/menu commands.
3. `TerminalWorkspace` renders the active workspace shell.
4. `ViewTabBar` manages workspace views (top tabs).
5. `LayoutRenderer` walks the split tree and renders each pane.
6. `paneRegistry` resolves `PaneKind` to the correct pane component.
7. Pane components call app actions and `window.swath.*` services for side effects.

For a headless process, startup instead loads connector configuration, opens the SQLite catalog,
starts the network/replication runtime, and serves authenticated connector and catalog RPCs. See
[the backend notes](./backend.md) and [the deployment guide](../deployment.md).

## Where code lives

- **Shared contracts**: `src/shared/types/*`, `src/shared/ipc/*`
- **Renderer shell**: `src/renderer/App.tsx`, `src/renderer/features/shell/*`
- **Domain mutations**: `src/renderer/domain/*`
- **Feature panes**: `src/renderer/features/tabTypes/*`, `src/renderer/features/terminal/*`, `src/renderer/features/views/*`, `src/renderer/features/panes/*`
- **Native backend**: `src-tauri/src/*`

## Key ideas

- Workspaces contain views.
- Views contain a split tree.
- Split leaves are panes.
- Pane type is controlled by `PaneKind`.
- New tab types are discovered through the tab registry, not hard-coded in the shell.

For more detail, read:

- [Renderer](./renderer.md)
- [Backend](./backend.md)
- [Shared models](./shared-models.md)
- [Tab system](../features/tab-system.md)
