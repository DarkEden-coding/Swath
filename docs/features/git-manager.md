# Git manager pane

This is the source-control pane.

## Main files

- `src/renderer/features/tabTypes/gitManager/gitManagerTabType.ts` — tab registration and default metadata
- `src/renderer/features/tabTypes/gitManager/GitManagerPane.tsx` — main UI and actions
- `src/renderer/features/tabTypes/gitManager/CommitGraphSvg.tsx` — commit graph rendering
- `src/renderer/services/gitClient.ts` — renderer wrapper for git RPC
- `src/shared/ipc/gitRpc.ts` — git request union and validation rules
- `src-tauri/src/git.rs` — native git implementation

## What the pane does

- reads status for staged, unstaged, and untracked files
- stages, unstages, and discards changes
- creates commits
- pulls, pushes, and syncs
- lists branches and switches branches
- shows commit history with a simple graph
- copies commit hashes

## Data flow

The renderer sends one RPC request to `window.swath.git.rpc(...)`, the Rust backend executes `git`, and the renderer parses the structured result.

## Why it is shaped this way

Git uses one stable RPC surface instead of many renderer methods.
That keeps the API easier to evolve and keeps Vite dev behavior aligned with Tauri.

## Maintenance notes

If you add a new git action:

1. extend `src/shared/ipc/gitRpc.ts`
2. update `src/renderer/services/gitClient.ts`
3. implement the Rust branch in `src-tauri/src/git.rs`
4. update the pane UI and any tests
