# Adding Pane and Tab Types

This app treats a top-level workspace tab as a `WorkspaceView` and each split cell as a `PaneLeaf`. Both are backed by a tab type registration, so a new kind like `gitManager` should be added mostly inside its own folder.

## Minimal Core Edits

1. Add the new kind to `src/shared/types/tabTypes.ts`.

```ts
export const paneKinds = ["terminal", "gitManager"] as const;
```

2. Create a folder for the implementation.

```text
src/renderer/features/tabTypes/gitManager/
```

3. Register the new type in `src/renderer/features/tabTypes/registry.ts`.

```ts
import { gitManagerTabType } from "./gitManager/gitManagerTabType";

const tabTypes: Record<PaneKind, TabTypeRegistration> = {
  terminal: terminalTabType,
  gitManager: gitManagerTabType,
};
```

## Folder Contract

Each tab-type folder should export a `TabTypeRegistration` from a file like `gitManagerTabType.ts`.

```ts
export const gitManagerTabType: TabTypeRegistration = {
  kind: "gitManager",
  label: "Git Manager",
  Component: GitManagerPane,
  createPaneMeta,
  createView,
  isBusy,
  closePane,
};
```

The registration fields are:

- `kind`: The shared `PaneKind` string.
- `label`: The display name used in top-tab and split-pane type menus.
- `Component`: The React pane component rendered for this kind.
- `createPaneMeta`: Creates default `PaneLeaf` metadata for split panes.
- `createView`: Creates a top-level `WorkspaceView` containing an initial pane of this kind.
- `isBusy`: Optional lifecycle hook used before closing panes/views/workspaces.
- `closePane`: Optional cleanup hook used when a pane/view/workspace closes.

## Component Props

Pane components receive `PaneComponentProps` from `src/renderer/features/panes/paneTypes.ts`.

```ts
export interface PaneComponentProps {
  workspace: Workspace;
  view: WorkspaceView;
  pane: PaneLeaf;
  settings: AppSettings;
}
```

Use these props instead of reading global workspace state when possible. If the pane needs to split, close, rename, or select itself, call the generic app actions rather than adding type-specific core actions.

## Top Tabs and Splits

Top-tab creation and split-pane creation are registry driven:

- The top-tab type menu renders `getTabTypes()`.
- Shift-clicking a split button opens the same registered type list.
- Splitting without shift defaults to the current pane kind.

This means future types should not need custom split or top-tab UI code unless they need a genuinely different user experience.

## Lifecycle Guidance

Use lifecycle hooks only for behavior owned by the pane type.

For example, terminal panes provide:

```ts
isBusy: (paneId) => terminalClient.isBusy(paneId),
closePane: (paneId) => terminalClient.kill(paneId),
```

A Git Manager pane might omit both hooks if it has no background process, or provide cleanup if it owns subscriptions, workers, or long-running tasks.

## Checklist

- Add the kind to `src/shared/types/tabTypes.ts`.
- Add a folder under `src/renderer/features/tabTypes/`.
- Export a `TabTypeRegistration` from that folder.
- Register it in `src/renderer/features/tabTypes/registry.ts`.
- Keep type-specific UI, defaults, and lifecycle behavior in the new folder.
- Run `npm run typecheck`.
