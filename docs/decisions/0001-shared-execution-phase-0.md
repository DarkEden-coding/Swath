# ADR 0001: Shared-execution Phase 0 decisions

**Status:** accepted for the implementation plan; implementation is deferred.

## Pi 0.85.1 contract

Verified against the locally installed `@earendil-works/pi-coding-agent` **0.85.1** documentation (`docs/rpc.md` and `docs/session-format.md`). `pi --mode rpc` is display-free and uses LF-only JSONL on stdin/stdout. Requests may carry an optional caller-supplied `id`; Pi echoes it only in the matching response, so the executor must allocate process-wide IDs before forwarding commands from multiple viewers.

`get_state` exposes `sessionFile`, `sessionId`, streaming/compaction state, and `pendingMessageCount`; `get_messages` returns the current conversation. A prompt during streaming needs `streamingBehavior: "steer"` or `"followUp"`; accepted responses mean accepted/queued/handled, not completed. `clear_queue` and `abort` are available for pending work.

Sessions are durable JSONL by default under `~/.pi/agent/sessions/`, with a v3 header and tree entries identified by stable `id`/`parentId`. `--session <path|id>`, `--fork <path|id>`, `--session-dir`, and `--no-session` are supported. The session file retains completed records; partial streaming `pending` is not persisted as a completed assistant record. Use RPC state and Pi session files as inputs to executor-owned durable records, not as the shared catalog.

## Consensus choice

Choose **OpenRaft 0.9** for the coordinated catalog. It is a maintained Rust Raft implementation and fits Tokio plus a SQLite-backed log/state-machine and snapshot store. Do not add it until the Phase 0 prototype below passes on supported platforms.

Prototype: launch three in-process OpenRaft nodes, each backed by a separate temporary SQLite database. Configure all three voters; write a catalog operation through the elected leader; stop that leader; wait for either survivor to become leader; write another operation; restart the former leader; then assert all three state machines converge and the restarted node installs/replays the snapshot/log. Repeat an attempted write to the stopped leader and assert it cannot commit. Run the same prototype on macOS, Linux, and Windows. Membership changes are out of scope for this spike, but production must use OpenRaft's safe reconfiguration path.

## Headless boundary

Pi RPC, `portable-pty`, Git, and filesystem operations do not require a display server. The current managers do require `AppHandle` to publish Tauri events and derive some application paths, so the Phase 2 gate is extracting an event publisher/runtime state from Tauri. Environment-driven connector startup alone is not evidence of headless support. Validate the extracted runtime on macOS, Linux, and Windows.

## Confirmed product policies

- Forking a dirty task quiesces its agents/processes first and preserves staged, unstaged, and untracked files exactly.
- The most recently used device remains the offline default; creation requires an explicit override rather than silently choosing another device.
- Import initializes non-Git legacy folders as Git repositories automatically.
- The most recently focused viewer controls a shared terminal's dimensions.
- Closing a shared running pane requires confirmation; hiding it in a local layout does not.
- Browser clients use authorized serving-node discovery and also offer a manual URL fallback.

## Current-characterization limits

A second Pi `spawn` for the same pane kills the first process. Terminal attachment replays via the global app event bus, `set_streaming` is session-global, and connector subscribers share one bounded broadcast channel (1024 events). These are intentionally characterized by focused dependency-free tests before their Phase 2/3 replacement.
