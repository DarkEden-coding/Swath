# Backend architecture

This is the Rust/Tauri side of the app. The same Rust library also powers the package-free
`swath-headless` binary used by a network catalog server.

## Startup

- `src-tauri/src/main.rs` starts the library.
- `src-tauri/src/lib.rs` builds the Tauri app, registers plugins, installs the menu, and manages `AppState`.
- `AppState` currently owns `TerminalManager`.
- `src-tauri/src/runtime.rs` owns the shared `Core`, configured data directory, connector, and
  executor lifecycle. `src-tauri/src/headless.rs` starts this runtime without a display.
- Network/catalog modules persist the single-server catalog and route authenticated executor
  requests. Desktop processes are clients/executors; they are not coordinators.

## Commands

`src-tauri/src/commands.rs` exposes Tauri commands for:

- config load/save
- dialogs and confirmations
- clipboard read/write
- terminal create/write/resize/kill/attach/restart/replay/set-streaming/is-busy
- git RPC
- platform/open-external helpers

## Config persistence

- `src-tauri/src/config.rs` stores `AppConfig` in `swath.sqlite3`.
- It normalizes missing defaults and migrates older config paths.
- This is the source of truth for workspaces, views, panes, settings, and shell profiles.
- The network catalog uses the same configured data directory. Headless deployments must provide
  an absolute `SWATH_DATA_DIR`; deployment defaults use `$HOME/.local/share/swath`.

## Terminal runtime

- `src-tauri/src/terminal.rs` owns PTY sessions.
- It spawns shells, streams output to the renderer, tracks replay buffers, and emits `terminal:data` / `terminal:exit` events.
- It also reports whether a session is busy so the UI can warn before closing.

## Git backend

- `src-tauri/src/git.rs` shells out to `git`.
- It returns structured JSON for status, log, branch list, stage/unstage/discard, commit, pull, push, sync, and checkout.
- Git is intentionally behind one RPC surface (`git:rpc`).

## Platform helpers

- `src-tauri/src/platform.rs` handles folder picking, confirm dialogs, clipboard, and opening external URLs.
- `src-tauri/src/menu.rs` creates the native menu and emits `app:command` events.

## Shared Rust models

- `src-tauri/src/types.rs` mirrors the shared TypeScript models.
- When a shared config or IPC shape changes, update both sides together.

## Backend rules

- Keep commands thin; put real logic in `config.rs`, `terminal.rs`, `git.rs`, or `platform.rs`.
- Prefer a single RPC per domain instead of many one-off commands.
- Keep Vite dev behavior aligned with Tauri behavior through `viteBrowserTpm.ts`.
