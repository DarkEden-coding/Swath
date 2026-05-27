# Adding Pane and Tab Types

A top-level workspace tab is a `WorkspaceView`; each split cell is a `PaneLeaf`. New kinds (for example `gitManager`) should live mainly under `src/renderer/features/tabTypes/<name>/`, with only a few shared touch points.

## What you must edit

1. **`src/shared/types/tabTypes.ts`** — append the new literal to `paneKinds` so `PaneKind` and the `tabTypes` record stay in sync.

2. **`src/renderer/features/tabTypes/<name>/`** — implementation folder: pane UI, optional `createView` / `createPaneMeta` helpers, and a `TabTypeRegistration` export.

3. **`src/renderer/features/tabTypes/registry.ts`** — import the registration and add one entry to the `tabTypes` object.

That is the full **renderer** checklist for a pane that only uses existing app actions and APIs.

## What you usually do *not* edit

- **`src/renderer/features/panes/paneRegistry.ts`** — built from `getTabTypes()`; adding a tab type updates it automatically.
- **Split / new-tab chrome** — top tabs and pane split buttons already use `getTabTypes()` and shift-click type pickers; no extra wiring per kind.

## Folder contract

Each tab-type folder exports a `TabTypeRegistration` (for example from `gitManagerTabType.ts`):

```ts
export const gitManagerTabType: TabTypeRegistration = {
  kind: "gitManager",
  label: "Source Control",
  Component: GitManagerPane,
  createPaneMeta,
  createView,
  isBusy,
  closePane,
};
```

Fields:

- **`kind`**: `PaneKind` string (must match `paneKinds` in shared types).
- **`label`**: shown in tab-type menus; also used as the default prefix for new tab titles (`viewActions` uses `getTabType(kind).label`).
- **`Component`**: React pane; props are `PaneComponentProps` from `src/renderer/features/panes/paneTypes.ts`.
- **`createPaneMeta`**: default metadata when splitting into this kind. **Include `kind` in the returned object** so `createPaneNode` never falls back to `"terminal"` by mistake.
- **`createView`**: builds a `WorkspaceView` whose root pane uses this kind (same `kind` rule as above).
- **`isBusy` / `closePane`**: optional lifecycle hooks for background work (terminal uses both; many panes omit them).

## Native backend features (optional)

If the pane needs privileged work (subprocesses, filesystem, etc.):

1. Prefer **one command/RPC surface per domain** so `window.swath` stays stable — Git uses `window.swath.git.rpc` with a discriminated `GitRpcRequest` in `src/shared/ipc/gitRpc.ts` (`op` field). New Git operations extend that union and the Rust `git_rpc` handler; **do not add a new renderer API method per command**.
2. Register the Tauri command in **`src-tauri/src/commands.rs`** and wire any module in **`src-tauri/src/lib.rs`**.
3. Expose or reuse a small renderer client (e.g. `gitClient.ts`) that calls `window.swath.git.rpc(...)`.
4. Update the **browser dev stub / Tauri adapter** in `src/renderer/viteBrowserTpm.ts` so `window.swath.git.rpc` exists in Vite-only and Tauri runs.

## Component props

```ts
export interface PaneComponentProps {
  workspace: Workspace;
  view: WorkspaceView;
  pane: PaneLeaf;
  settings: AppSettings;
}
```

Prefer these props over global state. Use existing `appActions` for split, close, focus, etc., instead of new core actions unless the behavior is truly global.

## Lifecycle

Use `isBusy` / `closePane` only for resources owned by that pane type (PTY sessions, watchers, etc.).

## Checklist

- [ ] Add kind to `paneKinds` in `src/shared/types/tabTypes.ts`.
- [ ] Add folder under `src/renderer/features/tabTypes/`.
- [ ] Export `TabTypeRegistration` and register it in `registry.ts`.
- [ ] Ensure `createPaneMeta` / `createView` set **`kind`** on the pane metadata passed to `createPaneNode`.
- [ ] Optional: extend domain IPC via a **single** channel + shared request type (see Git).
- [ ] Run `npm run typecheck`.
