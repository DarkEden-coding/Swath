# Terminal pane

This is the PTY-backed terminal feature.

## Main files

- `src/renderer/features/tabTypes/terminal/terminalTabType.ts` — tab registration, default metadata, busy/close hooks
- `src/renderer/features/tabTypes/terminal/TerminalPane.tsx` — main terminal pane UI
- `src/renderer/features/terminal/components/*` — terminal subcomponents (search bar, viewport, context menu)
- `src/renderer/features/terminal/hooks/*` — terminal instance, resize, clipboard helpers
- `src/renderer/features/terminal/input/terminalInputController.ts` — keyboard/paste/copy handling
- `src/renderer/features/terminal/runtime/terminalCache.ts` — cached terminal instances and replay state
- `src/renderer/features/terminal/utils/*` — keyboard helpers and tests
- `src/renderer/services/terminalClient.ts` — renderer API wrapper
- `src-tauri/src/terminal.rs` — native PTY/session manager

## How it works

1. The pane mounts and looks up its saved metadata (`cwd`, shell profile, env, title).
2. It creates or reuses an xterm instance and fits it to the container.
3. The renderer asks the backend to create/attach a PTY session.
4. PTY output streams back through `terminal:data`.
5. Pane close/restart actions go through `terminalClient` and `appActions`.

## Behavior to know

- The pane can show a prompt before the PTY session starts.
- It supports copy/paste, file-path paste quoting, search, web links, and a context menu.
- It caches terminal state so inactive panes can be reattached without losing everything.
- `isBusy` asks the backend whether the underlying process still has children.
- `closePane` kills the PTY session and disposes cached terminal state.

## Input handling

`terminalInputController.ts` owns:

- paste interception
- copy shortcuts
- modified Enter sequences
- search shortcut handling
- clipboard history-friendly behavior

## Maintenance notes

When changing terminal behavior, look at all of these layers together:

- renderer UI (`TerminalPane.tsx`)
- input handling (`terminalInputController.ts`)
- keyboard rules (`terminalKeyboard.ts`)
- runtime cache (`terminalCache.ts`)
- backend PTY manager (`src-tauri/src/terminal.rs`)