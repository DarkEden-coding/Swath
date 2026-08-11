# Swath

Swath is a fast, terminal-first desktop workspace manager for developers and coding agents. It keeps your projects, terminal views, split panes, shell profiles, and local environment setup in one sharp Tauri app so you can jump between work without rebuilding your terminal layout every time.

<img src="docs/screenshots/swath-workspace.png" alt="Swath workspace view" width="760">

## Why Swath

Swath is built for people who live in terminals all day and want their project context to stay organized.

- Keep every project in a dedicated workspace.
- Start terminals directly inside each workspace folder.
- Use views for separate flows like app server, tests, database, and agents.
- Split panes horizontally or vertically when one terminal is not enough.
- Resize panes and keep your preferred layout between launches.
- Tune fonts, cursor behavior, shell profiles, and global environment variables.
- Move fast with a quiet, dark, Ghostty-inspired interface.

## Screenshots

### Workspace

Projects live in the sidebar, terminal views stay across the top, and the active pane has quick controls for splitting and closing.

<img src="docs/screenshots/swath-workspace.png" alt="Swath workspace with a clean terminal pane" width="760">

### Split Panes

Split panes keep related terminal sessions visible side by side without leaving the workspace.

<img src="docs/screenshots/swath-split-panes.png" alt="Swath split terminal panes" width="760">

## Features

- Cross-platform Tauri app for macOS, Windows, and Linux packaging.
- Local project/workspace list with add, remove, rename, and drag-to-reorder.
- Multiple terminal views per workspace.
- Horizontal and vertical split panes.
- Resizable split ratios that persist across app launches.
- xterm.js terminal rendering with fit, search, and web-link addons.
- Real PTY-backed shells through the Rust native backend.
- Configurable terminal font, font size, line height, cursor style, and cursor blink.
- Shell profiles for `zsh`, `bash`, PowerShell, Command Prompt, or custom commands.
- Global environment variables applied to newly spawned panes.
- Optional confirmation before closing panes.
- SQLite-backed local config storage.

## Tech Stack

- Tauri 2
- Rust
- React
- TypeScript
- Vite
- xterm.js
- portable-pty
- rusqlite
- Zustand

## Getting Started

Install dependencies:

```bash
npm install
```

Start the development app:

```bash
npm run dev
```

This runs Tauri with a Vite-powered renderer and a Rust backend.

## Useful Commands

| Command                  | What it does                                            |
| ------------------------ | ------------------------------------------------------- |
| `npm run dev`            | Starts Swath in Tauri development mode.                 |
| `npm run dev:renderer`   | Starts only the Vite renderer dev server.               |
| `npm run typecheck`      | Runs TypeScript without emitting files.                 |
| `npm test`               | Runs the terminal paste test script.                    |
| `npm run test:unit`      | Runs Vitest unit tests.                                 |
| `npm run build:renderer` | Builds renderer assets into `dist/`.                    |
| `npm run build`          | Builds the Tauri app bundle.                            |
| `npm run dist`           | Builds distributable Tauri packages.                    |
| `npm run install:mac`    | Builds and installs Swath to `/Applications` on macOS.  |
| `npm run install:win`    | Builds Swath and creates a Windows Start Menu shortcut. |

## Keyboard Shortcuts

| Shortcut               | Action                  |
| ---------------------- | ----------------------- |
| `Cmd/Ctrl + Shift + O` | Add workspace           |
| `Cmd/Ctrl + T`         | New terminal view       |
| `Cmd/Ctrl + W`         | Close terminal view     |
| `Cmd/Ctrl + \`         | Split active pane right |
| `Cmd/Ctrl + Shift + \` | Split active pane down  |
| `Cmd/Ctrl + Shift + W` | Close active pane       |
| `Cmd/Ctrl + ,`         | Open settings           |

## Persistence

Swath stores app configuration locally in the Tauri app data directory as `swath.sqlite3`.

Saved between launches:

- Workspace list and order
- Active workspace
- Terminal views
- Split layouts and split ratios
- Active view and active pane
- Terminal appearance settings
- Shell profiles
- Global environment variables

Not restored after restart:

- Running terminal processes
- Terminal scrollback
- Process state
- Shell environment changes made after startup

Swath intentionally restores the workspace shape, not the running process tree. That keeps startup predictable while preserving the layout you care about.

## Packaging

Build distributable packages with:

```bash
npm run dist
```

Tauri writes artifacts under `src-tauri/target/release/bundle/`.

## Project Structure

```text
src/shared/      Domain types and renderer/backend command contracts
src/renderer/    React UI split into app, state, services, domain, and features
src-tauri/       Tauri/Rust backend, commands, PTY, SQLite, git, menu, bundle config
scripts/         Install helpers and tests
docs/screenshots README screenshots
public/          Static renderer assets
```

Pi users: the pi agent pane renders `ask_user_questions` prompts natively — see [pi agent pane](docs/features/pi-agent-pane.md) §3.3.

The core persisted model is generic: a `Workspace` owns named `WorkspaceView` records, each view owns a split `LayoutNode` tree, and each leaf is a `PaneLeaf` with a `PaneKind` such as `terminal`. Terminal processes remain runtime-only and are attached to persisted pane IDs when a pane is started.

## Notes

Swath keeps the implementation intentionally focused: no heavy component framework, no remote service requirement, and no account system. It is a local desktop tool for getting into the right terminal context quickly.
