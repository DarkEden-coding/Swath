# Tab system

This project has two related concepts:

- **workspace views**: the top tabs inside a project
- **panes**: the split cells inside a view

Both are driven by `PaneKind` and the tab registry.

## Key files

- `src/shared/types/tabTypes.ts` — allowed `PaneKind` values
- `src/renderer/features/tabTypes/types.ts` — `TabTypeRegistration` contract
- `src/renderer/features/tabTypes/registry.ts` — kind -> registration map
- `src/renderer/features/panes/paneRegistry.ts` — derived component registry
- `src/renderer/features/views/components/ViewTabBar.tsx` — new workspace view menu
- `src/renderer/features/panes/components/PaneToolbar.tsx` — split-to-kind menu
- `src/renderer/domain/views/viewActions.ts` — create/close/select/reorder views
- `src/renderer/domain/panes/paneActions.ts` — split/close panes and metadata

## Registration contract

Each tab type exports a `TabTypeRegistration`:

- `kind` — the `PaneKind` string
- `label` — shown in menus and used for default tab names
- `Component` — the pane React component
- `createPaneMeta` — default pane metadata when splitting
- `createView` — creates a new workspace view rooted in that pane kind
- `isBusy` — optional close-warning hook
- `closePane` — optional cleanup hook

## Current kinds

- `terminal`
- `gitManager`

## How it is wired

- `ViewTabBar` uses `getTabTypes()` for the new-tab chooser.
- `PaneToolbar` uses `getTabTypes()` for split-to-kind menus.
- `LayoutRenderer` uses `paneRegistry` to pick the UI component.
- `viewActions.addView()` uses the tab registration label to build default tab titles.
- `paneActions.splitPane()` preserves or overrides pane kind and metadata.

## Maintenance rules

- Add new kinds to `src/shared/types/tabTypes.ts` first.
- Register the new tab in `src/renderer/features/tabTypes/registry.ts`.
- Do **not** hand-edit `paneRegistry`; it is derived automatically.
- Always keep `createPaneMeta` and `createView` returning the right `kind`.
- If a tab owns resources, add `isBusy` and/or `closePane`.

## Related guide

- [Adding pane and tab types](../adding-pane-types.md)
