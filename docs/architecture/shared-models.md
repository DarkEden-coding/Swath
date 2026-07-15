# Shared models

Everything in `src/shared/` is meant to be understood by both the renderer and Rust.

## Core types

- `src/shared/types/config.ts` — `AppConfig`, folder picker result, confirm dialog request.
- `src/shared/types/workspace.ts` — workspace and view models.
- `src/shared/types/panes.ts` — pane tree, pane metadata, split nodes, terminal config.
- `src/shared/types/settings.ts` — app settings and shell profiles.
- `src/shared/types/tabTypes.ts` — `PaneKind` literals.
- `src/shared/types/terminal.ts` — terminal session and clipboard payloads.
- `src/shared/ipc/channels.ts` — IPC channel names.
- `src/shared/ipc/gitRpc.ts` — git request union and validation.
- `src/shared/ipc/schemas.ts` — schema helpers used by IPC validation.

## Important rules

- `PaneKind` is the source of truth for all tab kinds.
- If a pane kind changes, update the shared literal, renderer registry, and any persistence logic.
- `AppConfig` is the persisted document shape; Rust serializes it and the renderer mutates it.
- `PaneLeaf.kind` determines which pane component renders.
- `PaneMetadata` is where pane-specific saved data lives.

## Browser/Tauri bridge

- `src/renderer/global.d.ts` defines the `window.swath` API shape.
- `src/renderer/viteBrowserTpm.ts` creates the dev-time stub and Tauri adapter.

## When to touch shared models

Change shared types when:

- you add a new pane kind
- you add a new persisted config field
- you add a new native command or RPC payload
- you need both TS and Rust to agree on request/response shapes

When that happens, update both renderer and backend code in the same change set.
