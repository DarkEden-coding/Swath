# Renderer architecture

This is the React-side app structure.

## Boot sequence

- `src/renderer/main.tsx` starts the app.
- `src/renderer/viteBrowserTpm.ts` defines `window.swath` for Vite dev and Tauri.
- `src/renderer/App.tsx` is the root shell.
- `src/renderer/app/useAppBootstrap.ts` hydrates persisted config on startup.

## Main layers

### App shell

- `App.tsx` handles sidebar width, collapse state, command listeners, and the settings modal.
- `features/shell/components/Sidebar.tsx` manages project selection, rename, reorder, remove, and add-project actions.
- `features/shell/components/TerminalWorkspace.tsx` renders the active workspace body.
- `features/shell/components/StatusBar.tsx` shows active project/view/pane info.
- `features/shell/components/EmptyState.tsx` shows onboarding when no project exists.

### State

- `state/configStore.ts` stores the persisted `AppConfig`.
- `state/uiStore.ts` stores transient UI state such as active pane, sidebar width, and settings modal visibility.

### Domain actions

Domain files are mostly pure mutations over the config tree:

- `domain/workspaces/workspaceActions.ts`
- `domain/views/viewActions.ts`
- `domain/panes/paneActions.ts`
- `domain/layout/layoutTree.ts`
- `domain/settings/settingsActions.ts`

These functions are called from `app/appActions.ts`, which adds persistence, confirmations, and side effects.

### Services

Services are thin wrappers around `window.swath`:

- `services/configClient.ts`
- `services/dialogClient.ts`
- `services/terminalClient.ts`
- `services/gitClient.ts`

## Pane and tab rendering

- `features/views/components/ViewTabBar.tsx` renders workspace tabs and the new-tab menu.
- `features/panes/components/LayoutRenderer.tsx` recursively renders panes and split nodes.
- `features/panes/components/PaneFrame.tsx` supplies the shared pane chrome.
- `features/panes/components/PaneToolbar.tsx` supplies split/close controls and the split-kind picker.
- `features/panes/paneRegistry.ts` maps `PaneKind` to a React component.
- `features/tabTypes/registry.ts` maps `PaneKind` to the full tab registration.

## Common renderer rules

- Keep pure state changes in `domain/*`.
- Keep API calls in `services/*` or `appActions.ts`.
- Keep pane-specific UI inside its own feature folder.
- Use `getTabTypes()` for anything that should automatically support new pane kinds.

## Files to know first

- `src/renderer/App.tsx`
- `src/renderer/app/appActions.ts`
- `src/renderer/domain/layout/layoutTree.ts`
- `src/renderer/features/tabTypes/registry.ts`
- `src/renderer/features/panes/components/LayoutRenderer.tsx`
- `src/renderer/features/views/components/ViewTabBar.tsx`
