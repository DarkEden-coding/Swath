# Swath

A lightweight Electron desktop app for managing coding-agent terminal workspaces.

## What it does

- Cross-platform desktop app for macOS and Windows.
- Workspaces are local folders listed in the left sidebar.
- Each workspace stores terminal tabs and split layouts.
- Terminal panes start in the workspace folder.
- Terminal sessions are **not restored** after app restart; only the layout is restored.
- Ghostty-inspired dark terminal UI.
- Workspace add/remove/rename/reorder.
- Workspace search/filter.
- Multiple terminal tabs per workspace.
- Horizontal and vertical split panes.
- Resizable split panes.
- Local JSON persistence.
- Configurable font and shell profiles.

## Tech stack

- Electron
- React
- TypeScript
- Vite / electron-vite
- xterm.js
- node-pty
- Zustand

## Install

```bash
npm install
```

`node-pty` is a native dependency. The `postinstall` script runs `electron-builder install-app-deps` so the module is rebuilt for Electron.

## Development

```bash
npm run dev
```

## Type check

```bash
npm run typecheck
```

## Build unpacked app assets

```bash
npm run build
```

## Package installers

```bash
npm run dist
```

Outputs are written to `release/`.

## Shortcuts

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + Shift + O` | Add workspace |
| `Cmd/Ctrl + T` | New terminal tab |
| `Cmd/Ctrl + W` | Close terminal tab |
| `Cmd/Ctrl + \` | Split active pane right |
| `Cmd/Ctrl + Shift + \` | Split active pane down |
| `Cmd/Ctrl + Shift + W` | Close active pane |
| `Cmd/Ctrl + ,` | Settings |

## Persistence

Config is stored in Electron's user-data directory as `workspaces.json`.

Stored:

- workspace list
- workspace order
- active workspace
- terminal tab layout
- split ratios
- active tab/pane
- terminal settings
- shell profiles

Not stored:

- running terminal processes
- terminal scrollback
- process state
- environment state after shell startup

## Notes on performance

This implementation avoids heavy component libraries and spawns PTY processes only for panes currently mounted in the active tab. Electron still has a baseline memory cost. For substantially lower idle RAM, a future version could use Tauri + a Rust PTY backend, but Electron + node-pty is the more reliable starting point for cross-platform terminal behavior.
