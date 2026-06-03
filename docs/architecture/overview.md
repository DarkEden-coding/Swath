# Architecture overview

Swath is split into three layers:

- `src/shared/` — shared types and IPC contracts.
- `src/renderer/` — React UI, stores, domain actions, feature components, and browser/Tauri adapters.
- `src-tauri/` — Rust backend for config, PTY terminals, dialogs, clipboard, menu, and git.

## Runtime flow

1. `src/renderer/main.tsx` loads CSS, attaches `window.swath`, and renders `<App />`.
2. `App.tsx` hydrates config and listens for app/menu commands.
3. `TerminalWorkspace` renders the active workspace shell.
4. `ViewTabBar` manages workspace views (top tabs).
5. `LayoutRenderer` walks the split tree and renders each pane.
6. `paneRegistry` resolves `PaneKind` to the correct pane component.
7. Pane components call app actions and `window.swath.*` services for side effects.

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