# Shared projects and device-agnostic execution

## Purpose and status

This is an implementation plan for the requirements established during discovery. It is grounded in the current Swath repository, not a claim that these capabilities already exist. It changes the unit of execution from a machine-bound project to a portable task inside a shared project.

The target is one trusted user's devices on one Tailscale tailnet. Any native device can display the interface, execute tasks, or do both. Selected always-online devices coordinate shared state and replicate local Git repositories. Browser clients provide the full interface without executing native processes themselves.

**Central rule:** coordination can fail over automatically; tasks cannot. Each task has one assigned execution device until the user explicitly moves it.

Implementation choices below are proposals where discovery specified behavior rather than a mechanism. Resolve the technical gates in Phase 0 before treating a dependency, schema, or protocol detail as final. Do not implement a homegrown consensus algorithm or a general distributed filesystem to satisfy this plan.

## 1. Required behavior

### 1.1 Projects, tasks, and panes

- A shared project identifies a Git repository, not an absolute directory on one device.
- Projects contain tasks displayed in the project's top bar. Every pane belongs to a task.
- Each task has an isolated working directory and one execution device. All Pi, terminal, Git, file, and preview operations in that task use that device and directory.
- A new task begins with a Pi chat. It can contain multiple Pi chats and supporting panes. Pi chats in the same task may execute concurrently and modify the same files.
- Task creation offers a base branch or an existing task to fork. Default the branch to the project's configured base branch and the device to the most recently used task's device in that project. Allow an override; do not silently substitute a different device when the default is unavailable.
- Shared state includes project/task identity, task order, names, pane membership, device assignment, conversations, and lifecycle metadata.
- Active project/task selection, focused pane, window placement, and split layout remain interface-local.
- Both interfaces can send input to the same task. Pi uses its normal queuing semantics; terminal input reaches the same shell.

### 1.2 Execution and availability

- Native execution must support macOS, Linux, and Windows. Browser clients must support the full shared-project interface.
- Closing an interface must not stop work on another device. Work on the same device may stop when its Swath runtime exits.
- Always-online devices need a headless runtime. Starting a hidden desktop window is not sufficient for a Linux host without a display server.
- Disconnected interfaces may view cached history and save drafts. Do not queue submissions for later automatic execution.
- Existing executors may accept Pi messages and terminal input during loss of the coordinating majority. Creation, migration, cleanup, and shared catalog changes wait.
- A prompt is accepted after the executor durably saves it locally. Acceptance does not mean another device already holds a copy.
- Chat history and metadata sync automatically to other devices. Continuously backing up task working files is not required.

### 1.3 Transfer, history, and cleanup

- Task moves are explicit. Require agents to stop or finish, and confirmation before terminating terminals and development servers.
- Preserve Git history, edits, task-created files, and conversations. Transfer differences where possible. Exclude only explicitly configured rebuildable content and report exclusions.
- Device-local credentials and installed tools do not silently migrate. Check destination requirements first.
- Reopen panes without replaying commands. A shell process or running agent invocation does not migrate.
- An unreachable source blocks moving the original task. Offer a separate task from synced history and available commits, warning that work may be missing.
- Old inactive and completed tasks leave the top bar, but running tasks never disappear automatically. Default inactivity is two days without execution or content changes. Viewing does not count.
- A right-side history button opens the historical-task modal. Viewing a historical task temporarily restores it; choosing another task hides it again unless work reactivated it.
- Pi submissions, terminal input, file edits, and mutating Git actions reactivate completed tasks. Viewing, copying, searching, and layout changes do not.
- Cleanup is distinct from completion. Inspect uncommitted/untracked files and commits that are neither pushed nor merged into local main. Show what would be discarded and require confirmation.
- When cleanup relies on local integration, a majority of configured Git replicas must have stored the merged commits.
- Keep chats and metadata after workspace cleanup. Restore from a retained commit when work resumes. Explicitly discarded files and commits are not guaranteed to return.

### 1.4 Network, migration, and conflicts

- On upgrade, require network setup: discover and join a Swath network in the tailnet, or initialize its starting node.
- Joining requires approval and connector authentication. Tailnet membership alone does not authorize shell access.
- Promote coordinator devices explicitly. One can operate alone; two require both; three tolerate one unavailable coordinator.
- Support external Git remotes and local-only repositories replicated across always-online devices.
- Preview project imports and likely duplicate repositories. Confirm project identity and old-pane-to-task mapping before applying migration.
- Deduplicate identical Pi records and retain divergent histories as distinct branches or chats. Never rewrite original messages or tool records.
- When deterministic merging cannot resolve a conflict, open a resolution Pi pane configured for Terra with high reasoning. Require approval before applying its proposal.
- Source conflicts use a temporary merge worktree. Metadata conflicts need a structured proposal, not direct database editing. No automatic push, deletion of originals, or finalization of migration.
- If Terra is unavailable, keep the conflict unresolved and offer manual resolution or an explicitly chosen alternative model.

## 2. Current implementation and changes required

The following paths exist in the current repository. Proposed new paths later in this document are explicitly labeled.

| Area                  | Existing implementation                                                                                                                                                             | Consequence for this work                                                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace model       | `src/shared/types/workspace.ts`: `Workspace` owns `path`, optional `remoteConnectionId`, `views`, and active-view state. A group root is itself a workspace.                        | Introduce project and task identity rather than adding more optional fields to the old machine-bound workspace. Separate pane membership from local layout. |
| Config contract       | `src/shared/types/config.ts`: version 2 `AppConfig` contains all workspaces, settings, active selection, and remote connections. Rust counterparts are in `src-tauri/src/types.rs`. | Split shared records, local interface preferences, and local credentials. Do not synchronize the whole config object.                                       |
| Persistence           | `src-tauri/src/config.rs`: one SQLite `app_config` row stores JSON; `save` normalizes and replaces the complete object.                                                             | Use versioned shared mutations and transactional records. Keep config v2 readable for migration and rollback.                                               |
| Renderer mutations    | `src/renderer/app/appActions.ts`: `commit` updates the store and calls `configClient.save`; `withConfig` clones the entire config.                                                  | Replace shared whole-object saves with backend commands and applied events. Retain local preference saves separately.                                       |
| Domain actions        | `src/renderer/domain/workspaces/`, `domain/views/`, `domain/panes/`, and `domain/layout/`.                                                                                          | Reuse pane/layout behavior, but move task lifecycle and shared membership into a task domain.                                                               |
| Path routing          | `src/shared/ipc/remote.ts` and `src/renderer/platform/remoteAdapter.ts`. `swath-remote://` encodes connection ownership; `connectionFrom` scans request values for routed paths.    | Route new operations by task ID and executor generation. Paths become executor-local data, not identity or authorization.                                   |
| Remote ownership      | `createHybridSwath` keeps `terminalOwners` and `piOwners` in renderer memory and sometimes falls back to local execution if no owner is found.                                      | Persist authoritative ownership on the backend. Missing ownership must fail explicitly, never execute locally by accident.                                  |
| Connector             | `src-tauri/src/remote.rs`: Axum HTTP/WebSocket server, protocol v1, bearer/cookie authentication, Tailscale Serve, a shared event broadcast.                                        | Extend this transport with network identity, scoped subscriptions, command IDs, replay cursors, and task services. Preserve authentication.                 |
| Machine identity      | `RemoteServerManager::new` derives a machine ID from sanitized hostname.                                                                                                            | Store an immutable device ID; hostnames and URLs are editable attributes.                                                                                   |
| Pi runtime            | `src-tauri/src/pi_agent.rs`: `PiManager` holds one child per pane, forwards stdout, and `spawn` kills an existing process for that pane.                                            | Add idempotent attachment, executor-owned command acceptance, session identity, and persistence independent of a renderer.                                  |
| Pi UI                 | `usePiAgent.ts`, `piPaneCache.ts`, `eventReducer.ts`, and session components under `src/renderer/features/tabTypes/piAgent/`.                                                       | Renderer-local spawned/cache sets cannot establish process ownership across interfaces. Preserve reducers as display logic, not a durable source of truth.  |
| Terminal runtime      | `src-tauri/src/terminal.rs`: `TerminalManager`, attach/replay support, per-session `stream_to_ui`, global connector replay.                                                         | Separate session lifecycle from each viewer's subscription. One viewer hiding or attaching must not suppress or duplicate another viewer's stream.          |
| Git                   | `src-tauri/src/git.rs` and `src/shared/ipc/gitRpc.ts` implement cwd-based Git operations.                                                                                           | Add task provisioning, repository replicas, transfer, safe cleanup, and restore. Existing Git RPC is not a worktree manager.                                |
| Browser adapter       | `createRemoteWebSwath` in `remoteAdapter.ts` calls the serving host and loads/saves its config.                                                                                     | A browser needs network-wide routing and its own local preferences/cache, not the host's active selection and layout.                                       |
| Startup               | `src-tauri/src/lib.rs` creates managers through Tauri, auto-starts the connector from environment variables, shows a window, and kills managed processes on exit.                   | Extract only the runtime dependencies required to support a real headless entry point.                                                                      |
| Existing dependencies | `src-tauri/Cargo.toml` already includes Axum, Tokio, SQLite, Serde, and `portable-pty`; the renderer uses React, Zustand, Zod, and Vitest.                                          | Reuse them. Add a maintained consensus implementation only after the technical gate; do not introduce a second web stack or state-management framework.     |

Important existing traps to fix deliberately:

1. A second Pi client calling `spawn` can replace the first client's process.
2. Request IDs generated independently by different interfaces can collide inside a shared Pi process unless the backend correlates them.
3. Whole-config writes can overwrite another interface's project edits and local layout.
4. Terminal `set_streaming` is global to the session; replay goes through a shared event bus.
5. Client-side connection maps vanish on refresh. They cannot authorize or reconstruct execution ownership.
6. Existing group semantics combine project folders and layouts and enforce machine scope. They are not equivalent to the new isolated task concept.
7. Connector event broadcasts are ephemeral and do not prove a disconnected client received or persisted anything.
8. Environment-driven connector startup still uses a Tauri `AppHandle`; it is not proof of display-free operation.

## 3. Proposed architecture and contracts

### 3.1 Three responsibilities, one reusable runtime

```text
Native interface / browser interface
  ├─ local selection, layout, cache, drafts
  ├─ shared catalog commands → coordinator leader → replicated catalog
  └─ task commands / subscriptions → assigned executor
                                      ├─ Pi processes and session records
                                      ├─ terminals and replay buffers
                                      └─ task directory and Git operations

Always-online nodes
  ├─ explicitly configured coordinator membership
  ├─ configured Git replica membership
  └─ may also execute tasks and serve the web interface
```

Keep these responsibilities distinct even when one process performs all of them. Do not force every terminal keystroke through consensus. Do not let executor-local acceptance modify project identity or task ownership during a partition.

Use a runtime event publisher with actual native and headless consumers to remove the current `AppHandle` dependency where necessary. It should expose the events these managers already emit, not become a general plugin framework. Tauri commands and connector RPC dispatch should call the same task/runtime operations so local execution cannot bypass ownership validation.

### 3.2 Identity and records

Proposed record responsibilities, not a final migration schema:

| Record                     | Key fields and ownership                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Network                    | Immutable ID, schema/protocol version, enrollment state, coordinator membership and committed configuration revision.                                 |
| Device                     | Immutable random ID, display name, endpoints, platform, execution capabilities, enrollment identity, coordinator/replica roles. Secrets remain local. |
| Project                    | Immutable ID, name, repository source, default branch, configured Git replicas, task order, transfer exclusions. No single canonical OS path.         |
| Task                       | ID, project ID, title, creation time, base/ref information, assigned device, execution generation, lifecycle state, pane order.                       |
| Task pane                  | ID, task ID, pane kind, shared title/config, logical Pi session or terminal identity. No globally shared split geometry.                              |
| Executor task state        | Task ID and generation, local directory, process handles, running status, activity sequence, transfer state, terminal runtime IDs.                    |
| Chat/session records       | Stable session and record IDs, parent relationships, executor generation, source sequence, immutable payloads and attachment references.              |
| Local interface state      | Active project/task, focused pane, per-task layout, local drafts, temporary history selection, preferences and cache cursors.                         |
| Transfer/cleanup operation | Operation ID, task revision/generation, durable phase, checksums or inspected refs, approvals, outcome and actionable error.                          |
| Conflict                   | Stable conflict ID, source revisions, untouched original records, proposed resolution, approval and application state.                                |

Use tombstones or retained deletion records where a stale replica could otherwise resurrect removed panes/tasks. Use integer record revisions and durable sequence positions for ordering; wall-clock timestamps are display/activity data, not conflict arbitration.

Avoid one overloaded task status. Completion, workspace availability, and execution activity differ. For example, a completed task can have a retained directory, and a cleaned task can retain history. Model these dimensions explicitly enough that `completed` does not mean `files deleted` or `process stopped`.

### 3.3 Persistence and synchronization

Keep SQLite for local durable storage. Introduce versioned tables beside the existing config row rather than replacing it in place at the first release.

Separate these streams:

1. **Coordinated catalog operations.** Project creation, task creation, pane membership/order, ownership changes, cleanup authorization, and coordinator membership are applied through the committed catalog log.
2. **Executor-authored task events.** Accepted prompts, conversation records, task activity, and completion reactivation can be recorded by the current executor while the majority is unavailable. Replicate and deduplicate them when connectivity returns.
3. **Ephemeral display events.** Token deltas, PTY live output, presence, and progress may stream without consensus. Recover durable conversations from session records; recover terminal display only within its advertised replay window.
4. **Local preferences.** Interface layout, focus, drafts, and credentials never enter the shared catalog.

Identify executor records by task ID, execution generation, source identity, and monotonic sequence. Never merge a stale generation into the current live session as though it were current execution. Preserve old-generation history for inspection.

Expose distinct statuses: saved locally, replication pending, synchronized through sequence N, and unavailable. Do not label a locally accepted message as safely replicated.

New clients obtain a catalog snapshot plus subsequent events. Reconnecting clients request changes after their stored cursor. When a cursor has expired, resnapshot explicitly. Slow subscribers must not silently miss records after the connector broadcast buffer overruns.

Native interfaces cache metadata/chat records in SQLite. Browser interfaces need their own IndexedDB cache and local preferences; do not save their layout into the serving host's config. Browser cache contents are sensitive conversation data. Enrollment reset should offer cache removal, and credentials must not be included in catalog snapshots.

### 3.4 RPC and event changes

Extend `src/shared/ipc/swath.ts`, `remote.ts`, `schemas.ts`, and Rust equivalents together. Validate at both native and remote boundaries.

Proposed groups:

- `network`: discover, initialize, request join, approve, inspect membership, promote coordinator.
- `projects`: list/import/create, source/ref information, replica health.
- `tasks`: create/fork, rename/reorder, pane membership, complete, inspect, prepare/move, cleanup preview/confirm, restore.
- `sessions`: attach, current state, subscribe after cursor, submit command, stop, retained history.
- `sync`: snapshot, changes, acknowledgement and conflict inspection.

These are responsibilities, not a requirement for a separate service per verb. Keep the existing WebSocket multiplexing where useful. Use a distinct authenticated streaming route for bulk file transfer rather than encoding repository archives as one enormous JSON RPC message.

Mutating requests need a stable operation ID and relevant expected revision/generation. Executor calls carry a task ID and resolve cwd on the server. Include structured errors such as `executor_unreachable`, `stale_generation`, `quorum_unavailable`, `destination_not_ready`, and `cleanup_preview_stale`.

Protocol negotiation must reject incompatible peers clearly. An old v1 client must not retain whole-config write access after a device migrates to the shared model. Preserve v1 only for the explicit import bridge or another bounded compatibility path.

### 3.5 Coordinator and Git replica membership

Use a maintained consensus library suitable for the Rust runtime, with durable storage, snapshots, membership changes, and testable leader failover. Evaluate a Raft implementation in Phase 0 rather than writing election logic on top of heartbeats.

Coordinator membership and Git replica membership are different sets. Both must be explicit and versioned. Do not infer quorum from the devices currently reachable.

- One configured coordinator: majority is one.
- Two configured coordinators: majority is two.
- Three configured coordinators: majority is two.
- Membership changes use the selected library's safe reconfiguration protocol. A timeout cannot automatically demote an unavailable voter.
- A stale coordinator cannot commit catalog writes without a majority.
- Executor ownership does not expire merely because the coordinator is unreachable. This permits accepted existing-task work during a partition without automatic execution takeover.

A manual transfer requires the source executor to acknowledge a durable freeze before changing ownership. A generation number alone does not stop an isolated process that never received the new generation.

## 4. Implementation phases

Each phase should leave a reviewable, testable change. Temporary development flags may keep unfinished behavior out of the normal startup flow; they must not become a permanent second project model.

### Phase 0. Characterize current behavior and settle technical gates

**Work**

1. Capture baseline validation results before refactoring. Record existing failures separately.
2. Add a small two-client characterization test around remote Pi and terminal attachment. Reproduce destructive Pi spawn, global terminal replay, and subscription interference before fixing them.
3. Verify the installed Pi RPC/session contract: attachment/state queries, stable message IDs, session tree records, durable file behavior, pending command handling, and supported resume APIs. Read the installed Pi documentation before changing its integration.
4. Compare maintained Rust consensus options against Windows/macOS/Linux builds, SQLite integration, snapshot recovery, and dynamic membership. Write a short decision entry with one chosen dependency and a failing-leader prototype.
5. Verify a display-free runtime can reuse PTY, Git, files, and Pi operations after replacing their Tauri event dependencies.
6. Specify task-fork semantics for dirty source tasks, initial behavior when the previously used device is offline, and handling of non-Git legacy folders. These were not fully settled by discovery. Proposed behavior is to stop/quiesce before an exact dirty fork, ask for another device rather than substitute, and retain unsupported legacy folders without destructive conversion until the user chooses how to import them.
7. Define how browser discovery works. Native clients can query Tailscale peer information; browser clients cannot run the Tailscale CLI or freely probe every peer. A serving node can provide authorized discovery plus a manual URL fallback.
8. Define initial activity, terminal resize, and pane-close policies. Proposed policies: execution/file changes count as activity, most recent focused viewer controls terminal dimensions, and removing a shared running pane requires explicit confirmation distinct from hiding it locally.

**Exit gate:** chosen consensus/Pi/headless approaches demonstrated; remaining product choices documented and confirmed before their dependent phases.

### Phase 1. Introduce stable identity and split persistence

**Existing files:** `src/shared/types/workspace.ts`, `config.ts`, `panes.ts`; `src-tauri/src/types.rs`, `config.rs`; `src/renderer/state/configStore.ts`, `uiStore.ts`; `src/renderer/domain/config/configSanitizer.ts`.

**Proposed additions:** `src/shared/types/projects.ts`, `tasks.ts`, `network.ts`; a Rust `network/` module for network storage and identity; a task storage module when task operations are introduced.

1. Add immutable network/device/project/task/pane/session IDs. Map existing hostname connection IDs to enrolled device IDs without silently merging two machines with the same name.
2. Add schema migrations and migration-version records. Reject unknown versions and corrupt required state with actionable errors instead of silently replacing shared data with defaults.
3. Preserve the original v2 config and backups. Move local settings, credentials, focus and layout into a distinct local record.
4. Introduce backend catalog queries and command results while retaining a narrow legacy projection for still-unmigrated UI components.
5. Add record revision checks, operation deduplication, deletion tombstones, and transactional outbox entries as the corresponding operations need them.
6. Define a per-device path map. Never apply local filesystem existence checks to a shared project whose task may live elsewhere.

**Acceptance:** migration can run twice without duplicating records; two identical hostnames remain distinct; changing local layout does not change another interface's state; migration failure leaves v2 readable.

### Phase 2. Separate the runtime from the desktop window

**Existing files:** `src-tauri/src/lib.rs`, `main.rs`, `commands.rs`, `remote.rs`, `terminal.rs`, `pi_agent.rs`, `git.rs`, `config.rs`; `src-tauri/Cargo.toml`.

1. Extract concrete runtime state and an event publisher from `AppState`/Tauri setup. Inject application data paths and the event publisher into operations that currently require `AppHandle` only for paths or events.
2. Keep desktop dialogs, native clipboard/menu integration, and window persistence in the desktop layer.
3. Add a headless entry point that initializes storage, managers, authenticated connector, and graceful shutdown without constructing a window or needing a display server.
4. Make runtime startup acquire an exclusive data-directory/runtime lock. A desktop and a headless instance must not each start processes for the same device/task. Let the desktop attach to an already-running local service where configured.
5. Document desktop-owned versus service-owned shutdown. Disconnecting a UI never invokes `kill_all` on a separate service; exiting the actual executor still performs explicit shutdown.
6. Preserve Windows `pi.cmd` handling and native PTY behavior. Test process-tree termination, not only killing the parent Pi process.

**Acceptance:** a Linux host without a display can execute Pi and a shell; all three platforms can start the runtime; UI attachment does not create a second runtime; shutdown leaves accurate interrupted state.

### Phase 3. Add network enrollment and coordinated catalog operations

**Existing files:** `src-tauri/src/remote.rs`; `src/shared/ipc/remote.ts`, `swath.ts`, `schemas.ts`; `src/renderer/platform/remoteAdapter.ts`; `src/renderer/features/remote/RemoteConnectModal.tsx`.

1. Add create-network and discover/join flows with a manual address fallback. Identify networks separately from tailnets and connector URLs. If discovery finds several networks, require selection.
2. Approve enrollment explicitly; store device authentication material locally. Do not return connector tokens in config/catalog snapshots.
3. Preserve loopback binding behind Tailscale Serve and authenticated native/browser access. Review permissive CORS, WebSocket Origin checks, cookie attributes and CSRF defenses before adding broader browser mutations.
4. Implement catalog leader routing, committed revisions, snapshot recovery, promotion and safe membership changes with the selected library.
5. Surface coordinator health and quorum requirements in setup/settings. Explain that adding a second voter makes both necessary until there is a third.
6. Add durable command deduplication for catalog mutations. A lost response must not create a second task on retry.
7. Preserve cached browsing when no coordinator is available. Block catalog mutations with a useful error rather than silently queuing them.

**Acceptance:** approved peers join the same network; unapproved peers cannot execute commands; a three-voter setup survives one failure; a two-voter setup rejects catalog writes after losing one; old protocol writers cannot overwrite the new catalog.

### Phase 4. Provision task directories and local Git replicas

**Existing files:** `src-tauri/src/git.rs`, `files.rs`; `src/shared/ipc/gitRpc.ts`, `filesRpc.ts`; existing remote directory browsing.

**Proposed additions:** `src-tauri/src/tasks/` for task lifecycle/workspace operations, with focused Git replica and transfer modules as those responsibilities grow.

1. Store project source identity separately from execution paths. External Git URL normalization may suggest duplicates but cannot by itself authorize merging projects.
2. Use standard Git commands for object transfer, branches, worktrees, ancestry, and verification. Prefer a per-project repository on each relevant executor with isolated worktrees for tasks; verify this choice in the portability tests.
3. Provision a task transactionally: create a pending task, fetch the selected source, resolve the exact base commit, create its task branch/worktree, then mark it ready. Failed provisioning must not leave a usable-looking task with no files.
4. For local-only projects, replicate refs/objects among configured always-online nodes. Retain exact commit/ref receipts so cleanup can prove which replicas have the required history.
5. Do not invent multi-master Git branch merging. Serialize shared main-ref updates through catalog authority and use compare-and-swap on expected refs. Divergence becomes a conflict requiring an explicit merge.
6. Permit cloning/fetching from any valid replica that holds the requested commit. Commit availability must be verified, not inferred from a healthy node badge.
7. Handle unborn repositories, detached HEAD, submodules, Git LFS, sparse checkouts, case collisions, symlinks and file modes explicitly. Support a case safely or block it with an actionable preflight error; never quietly drop content.
8. New task creation picks a device as specified and starts with Pi only after provisioning succeeds. Do not launch project setup commands implicitly without an established approval policy.

**Acceptance:** two tasks cannot overwrite each other's directories; local-only tasks can be created from another replica; failure midway through provisioning is recoverable; supported cross-platform checkouts preserve expected content.

### Phase 5. Make execution task-scoped and safe for multiple interfaces

**Existing files:** `remoteAdapter.ts`, `tauriAdapter.ts`, `src/shared/ipc/swath.ts`, `piRpc.ts`; `src-tauri/src/commands.rs`, `remote.rs`, `pi_agent.rs`, `terminal.rs`; `usePiAgent.ts`, `piPaneCache.ts`.

1. Resolve every new execution request from task ID, pane/session identity, and generation. Treat any supplied path as a validated relative resource or an explicit privileged import input.
2. Remove implicit local fallback for tasks whose executor is unknown or disconnected. Attach/reconnect should restore routing from durable records rather than renderer maps.
3. Replace renderer-driven Pi spawning with an idempotent ensure/attach operation owned by the executor. Explicit restart remains destructive and separately authorized.
4. Correlate Pi command IDs across clients. Separate shared process events from responses intended for a particular request. Prevent two clients from answering the same interactive tool approval differently.
5. Record a submitted prompt and its deduplication ID durably before acknowledging acceptance. Track accepted/dispatched/completed/uncertain states. If a crash occurs around the write to Pi stdin, do not blindly resend and promise exactly-once execution.
6. Keep Pi's native session records and branch structure intact. Use a logical Swath session ID mapped to device-local session paths, not a globally valid absolute `sessionFile` string.
7. Attach terminal viewers independently. Scope replay to the attaching viewer and maintain live subscriptions per connection. Hiding one terminal must not disable another client's output.
8. Distinguish attaching to a live shell from restarting an exited shell. Inspecting a historical task must not create processes or reactivate it.
9. Apply the agreed terminal resize policy and serialize terminal writes without losing bytes. Full durable terminal scrollback is not part of the requirement; advertise bounded replay honestly.
10. Record executor-side activity/reactivation for Pi submissions, terminal input, file changes, and mutating Git calls. Do not rely exclusively on mounted React components to detect work.
11. Keep tool approvals, question dialogs, and cancellation functional from either interface, including when one disconnects after opening a dialog.

**Acceptance:** attaching a second browser leaves the original Pi PID intact; both interfaces see the same transcript; one client's tab switch does not suppress terminal output for another; missing executor ownership never runs a command locally; duplicate prompt request IDs do not cause duplicate normal dispatch.

### Phase 6. Replicate history, metadata, and resumable subscriptions

**Existing files:** `src-tauri/src/pi_agent.rs`, `remote.rs`; `remoteAdapter.ts`; Pi event reducer/cache/session list/tree components; config stores.

1. Persist immutable session records and references to attachments needed to render history. Preserve original tool outputs and tool-call relationships.
2. Replicate task metadata and chat records using stable IDs and source cursors. Append-only history must not be resolved through last-writer-wins replacement of an entire JSONL file.
3. Read complete session records only; a partially written JSONL tail is not a corrupt conversation to discard. Keep live token deltas separate from durable records.
4. Reconnect with snapshot plus cursor. Verify sequence gaps and fetch missing records before presenting a transcript as synchronized.
5. Support cached history while the executor is offline. An interface must not need `spawn` or access to the executor's session directory merely to read a conversation.
6. Persist native caches and browser IndexedDB caches with network IDs so changing networks does not blend histories.
7. Preserve local unsent drafts without creating a network outbox that later runs them. Distinguish a draft from a command whose acceptance result is uncertain after disconnection.
8. Reconcile executor-authored events after partitions, including completed-task reactivation. Keep ownership/catalog changes majority-controlled.
9. Detect divergent chat records and produce conflict records while retaining original branches. No automatic model rewrite of chat records.

**Acceptance:** a powered-off executor's previously synced chat is readable from another interface; disconnect/reconnect catches up without duplication; acknowledged local-only messages display replication status honestly; incomplete session tails survive restart without loss of prior records.

### Phase 7. Replace the workspace/group UI with project tasks

**Existing files:** `src/renderer/app/appActions.ts`, `App.tsx`; domain workspaces/views/panes/layout; `src/renderer/features/shell/components/TerminalWorkspace.tsx`, `Sidebar.tsx`; `src/renderer/features/views/components/ViewTabBar.tsx`; `src/renderer/features/panes/components/LayoutRenderer.tsx`; tab registry/types; local stores.

**Proposed additions:** `src/renderer/domain/tasks/` and `src/renderer/features/tasks/` for task actions, the task bar, creation/move dialogs and history modal. Add files by responsibility, not one generic distributed-state framework.

1. Render projects in the project list/sidebar and tasks in the project's top bar. Replace task-level per-pane execution selectors with one task device selector.
2. Preserve existing split rendering and tab-type registration. Rebind their context to a task rather than a globally shared `Workspace.path`. Replace `groupPathsFor`, `GROUP_VIEW_KINDS`, and group-root checks in Pi startup. Update `PiRootsContext.tsx`, file completion, live diffs and image resolution so a task cannot accidentally regain access to unrelated old group directories.
3. Separate shared pane membership from interface-local layout. If a new shared pane appears, place it using a deterministic local default without overwriting the viewer's existing geometry. Remove stale local layout references when membership changes.
4. Route shared actions through backend commands; apply committed events to the shared store. Keep local focus/layout mutations synchronous and device-local.
5. Preserve local last-used-task state for choosing the next device without synchronizing focus between interfaces.
6. Add create-task flow, initial Pi pane, device status/selection, completion controls, cleanup preview and restoration states.
7. Implement history filtering from executor-reported activity, configured threshold and running state. For unavailable executors, show activity as stale rather than assert that the task is idle.
8. Implement ephemeral history selection locally. A historical task stays in the top bar only while selected unless a qualifying action reactivates it.
9. Keep opening history read-only. Any restore/restart needed for subsequent work is explicit and must not accidentally replay the last command.
10. Update keyboard/menu commands, pane close behavior, drag ordering, empty states and error displays. Audit all callers of old workspace/group helpers before removing their compatibility projection.

**Acceptance:** two interfaces share task order and panes while keeping different split layouts; a history view does not spawn processes; switching tasks hides the temporary historical task; running tasks never age out; work reactivates completed tasks on all interfaces.

### Phase 8. Implement transactional manual transfer

**Proposed durable phases:** requested → preflight → source frozen → destination staged → verified → ownership committed → source retired → complete.

1. Preflight destination capabilities, free space, Git requirements, tools, file portability and configured exclusions before disrupting running work.
2. Show the processes to be stopped. Require agents to finish or stop and confirmation for shells/servers. Stop child processes and prevent new task writes during the snapshot.
3. Persist the source freeze and transfer operation ID. The source must remain fenced across its own restart until the transfer is resolved or safely canceled.
4. Transfer Git objects/refs using Git facilities. Reconstruct the destination worktree rather than copying its `.git` pointer to a path that only exists on the source.
5. Preserve staged and unstaged changes separately, deletions, renames, untracked files, binary content, symlinks and supported file modes. Do not collapse the index into a patch that loses staging intent.
6. Transfer retained session data and task-created assets. Inspect historical absolute paths and session cwd metadata: rebind runtime paths without rewriting original messages/tool results.
7. Use a manifest and bounded chunk transfers with integrity checks. Reject path traversal, absolute archive paths, symlink escapes, unsupported cross-platform names and overwritten destination files. Resume a failed transfer by operation ID.
8. Show exclusions and explicitly handle credential-bearing files. Device-local credential stores must never enter a generic directory archive. A project-local secret file requires a clear policy/approval, not silent inclusion or silent loss.
9. Verify the staged directory and refs before committing the new executor/generation through the coordinator. The destination must not execute before that commit; the source must remain frozen afterward.
10. Retire source runtime mappings after commit. If source cleanup fails, leave its copy fenced and report it. Do not re-enable it as an alternate executor.
11. Reopen panes on the destination without replaying commands or reviving the previous agent invocation. Resume the conversation only when the user continues work.
12. Test crashes at each durable phase. Before ownership commits, cancellation can restore source authority after staged-state cleanup; after commit, recovery completes the transfer rather than silently reversing ownership.

**Acceptance:** an interrupted transfer cannot produce two writable executors; index/worktree state matches the source snapshot; a coordinator outage pauses ownership changes safely; a source restart does not bypass its freeze; moves between supported OS pairs report incompatible paths before losing data.

### Phase 9. Implement completion, cleanup and reconstruction

1. Completion changes lifecycle metadata only. It does not automatically commit, push, merge, kill work, or delete directories.
2. Cleanup preview reports dirty tracked files, untracked/ignored files that would be removed, local-only commits, merge/push evidence, workspace size and processes that must stop.
3. Check safety per commit, not merely whether HEAD is on main or the working tree is clean. Preserve all required task refs and relevant local branches, not just the selected branch tip.
4. Verify pushed history against the relevant remote state. A stale local remote-tracking ref is not enough evidence. For local integration, verify main ancestry and durable object/ref receipts from a majority of configured Git replicas.
5. Bind approval to the inspected generation, refs and worktree snapshot. Recheck immediately before deletion; new work invalidates the approval. Freeze execution while deleting files.
6. Allow explicit discard of unpreserved work only with a concrete loss summary. Record the retained restore commit and known losses. Do not claim the abandoned commit remains restorable.
7. Remove the managed worktree through safe Git operations and bounded filesystem deletion. Never recursively delete a user-selected project path without proving it is the managed task directory.
8. Retain chat records, pane metadata, restoration information, completion history and cleanup results.
9. Read-only history remains usable after cleanup. On subsequent work, reconstruct from the retained commit, check dependencies/device availability, and reactivate after a qualifying action. If the retained objects are unavailable, report the problem rather than create an empty workspace.

**Acceptance:** cleanup detects unpushed commits in an otherwise clean tree; changed refs invalidate stale confirmation; only managed workspaces are removed; explicit discarded work is reported on restore; retained chat history survives cleanup.

### Phase 10. Complete browser parity and remote previews

**Existing files:** `remoteAdapter.ts`, `tauriAdapter.ts`; `src-tauri/src/remote.rs`; pane types and browser/file APIs.

1. Provide browser routes to the current executor independent of which node serves the HTML. Prefer an authenticated serving-node gateway for browser RPC/preview traffic where it avoids distributing every device token to JavaScript. Update `src/renderer/platform/installSwathAdapter.ts` and `browserFixture.ts` with task-shaped fixtures and operations so browser development does not keep exercising the obsolete workspace model.
2. Keep browser-local preferences/cache separate from host-local preferences. Page refresh restores attachments, not ownership maps reconstructed by spawning processes.
3. Audit each pane type for native-only APIs, path assumptions, file URL use, clipboard/image upload, dialogs, downloads and external navigation. Route filesystem-dependent work to the task's executor.
4. Add authenticated preview proxying for explicitly selected task ports. Support WebSocket upgrades used by development servers. A worker's `localhost` must not be interpreted as the browser device's localhost.
5. Restrict preview destinations and paths to approved task resources. Do not create an arbitrary internal-network proxy. Isolate preview content from the control UI's authentication origin where needed.
6. Keep Pi browser tools executing on the task device with that device's installed browser/profile configuration. A browser-only Swath interface does not imply migrating an authenticated browser profile.
7. Validate full browser workflows on Windows as well as macOS/Linux native interfaces, including reconnect and long-running sessions.

**Acceptance:** a browser served by node A can interact with a task on node B, access its preview and reconnect without restarting it; preview content cannot gain Swath control credentials; local UI layout is independent of node A's desktop.

### Phase 11. Ship mandatory migration and assisted conflict resolution

**Existing files:** config normalization/sanitization; workspace/group actions; `src/shared/ipc/remote.ts` import helpers; Pi pane creation and model selection components.

1. Gate normal upgraded startup on creating/joining a network. Keep a backup/export path accessible if setup cannot complete. Do not destroy local data because a coordinator is unavailable.
2. Inventory each device's projects, group roots, member projects, views, panes, Pi session files, remote profiles and Git state. Preserve original records and session files before planning imports.
3. Produce a preview with repository identity suggestions and explicit old-to-new mappings. Existing groups may span multiple folders/repositories and cannot be blindly mapped to one isolated task directory.
4. Let the user confirm project identity and task grouping. Preserve unknown pane metadata and record unsupported items rather than dropping them during normalization.
5. Make import transactional and resumable by a stable import operation ID. Do not repeat project/chat imports after a retry or another device joins.
6. Apply deterministic record deduplication first. Preserve divergent chat histories and conflicting originals.
7. Create a conflict-resolution task/pane when unresolved conflict records appear. Resolve the configured Terra identifier to an available provider/model and set high reasoning; do not assume the display alias is an API model ID.
8. Supply bounded conflict input and explicit instructions. For source conflicts, grant access to a temporary merge worktree. For catalog conflicts, have the agent emit a schema-validated proposal; never grant direct SQLite mutation as the resolution mechanism.
9. Treat imported repository/chat content as untrusted instructions. Do not expose enrollment credentials or unrelated device secrets to the resolution agent.
10. Present code diffs and structured metadata mappings for approval. Validate source revisions again at application time, commit approved changes through normal APIs, and retain an audit record.
11. Deduplicate conflict jobs so an unresolved conflict does not open a new pane on every synchronization retry. New input revisions invalidate old proposals.
12. If Terra is unavailable, show manual/explicit-alternative options without silently switching models. No automatic pushes, destructive cleanup, or final migration acceptance.
13. Stop exposing legacy whole-config writes once migration completes. Retain documented backups; remove temporary compatibility code only after migration/recovery tests pass.

**Acceptance:** interrupted migration resumes without duplicates; two copies of a chat deduplicate without losing tool records; multi-repository groups require explicit mapping; conflicting metadata cannot be rewritten by an unapproved model response; unavailable Terra does not lose migration data.

## 5. Test and validation strategy

Prefer a small set of realistic behavioral tests around the failure boundaries. Reuse Vitest and Rust tests already present; do not add a second general-purpose test framework. Use actual temporary Git repositories and durable storage for transfer/cleanup tests rather than mocking the behaviors that could lose data.

### 5.1 Required behavioral scenarios

| Scenario                                                             | Expected result                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Two interfaces attach to one running Pi pane                         | One process survives; both render the same session; request responses do not collide.                                                 |
| One terminal viewer hides or reconnects                              | Other viewers keep streaming and do not receive duplicate replay.                                                                     |
| Prompt response is lost and client reconnects                        | Query acceptance by operation ID; no automatic duplicate normal submission. Ambiguous dispatch is explicit after a runtime crash.     |
| Executor continues during coordinator partition                      | Local work/history persists; task creation, moves and cleanup remain blocked.                                                         |
| Three coordinators lose their leader                                 | Committed catalog state survives and a majority selects a leader; no task process moves.                                              |
| Two coordinators lose one voter                                      | Shared writes reject; reachable executors continue existing tasks.                                                                    |
| Task executor disappears                                             | Synced history remains readable; original task cannot move until source returns. Separate-task recovery warns about unavailable work. |
| Manual transfer crashes before/after ownership commit                | Exactly one execution owner remains authorized; source freeze survives restart; operation resumes or cancels safely.                  |
| Dirty task moves across OSes                                         | Staged/unstaged/untracked/binary content survives, or unsupported content is identified before commit.                                |
| Task becomes old while a process is active                           | It remains visible. Reading history does not update activity.                                                                         |
| Completed task is inspected, then edited                             | Inspection stays read-only; the edit reactivates it and syncs that state.                                                             |
| Cleanup preview becomes stale                                        | Deletion is rejected and a fresh preview is required.                                                                                 |
| Local-only task is clean but has unreplicated commits                | Cleanup blocks or requires explicit discard; cleanliness alone is not safety.                                                         |
| Browser reads a task on another node                                 | Correct executor routing, independent layout, authenticated preview and session continuity.                                           |
| Duplicate/conflicting imports                                        | Stable deduplication, preserved originals and explicit approval for unresolved mappings.                                              |
| Unapproved peer, stale generation, hostile archive or preview target | Request is rejected before execution/filesystem mutation.                                                                             |

### 5.2 Existing test locations to extend

- `src/shared/ipc/remote.test.ts` and `piRpc.test.ts`: protocol decoding, identity and migration compatibility.
- `src/renderer/domain/config/configSanitizer.test.ts`: local/shared state separation and migration preservation.
- `src/renderer/domain/workspaces/workspaceActions.test.ts` and `groupActions.test.ts`: legacy mapping; add task-domain behavior tests rather than forcing new semantics into old grouping tests.
- `src/renderer/features/tabTypes/piAgent/` tests: session rendering, event reduction, activity, scoped model selection and conflict proposals where applicable.
- Terminal cache/input tests under `src/renderer/features/terminal/`: multi-viewer lifecycle behavior with the backend integration checks.
- Rust tests near connector, terminal replay/process, Git and new task/network modules: real persistence, process attachment, ownership and file safety.

### 5.3 Validation commands

Run from the repository root. TypeScript is installed globally; use `tsc`, not `npx tsc`.

```sh
# Renderer contracts and checks
tsc --noEmit
npm run lint
npm run test:unit
npm test
npm run build:renderer

# Rust formatting, tests and lint
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# Formatting
npm run format:check
```

Scope tests during each change, then run the complete relevant checks before merging a milestone. Use existing install scripts for platform packaging checks: `scripts/install-mac.sh`, `scripts/install-windows.ps1`, and `scripts/install-fedora.sh`. Do not run installers as part of an ordinary unit-test pass.

Build the renderer before Rust commands when embedded web assets require it. Run the headless and multi-device checks with isolated data directories and loopback test ports; never point integration tests at personal projects or the live Swath database.

Real acceptance requires macOS, Linux and Windows runs. A successful macOS build does not establish Windows path, process-tree, shell, symlink or PTY correctness.

## 6. Delivery order and completion criteria

### Milestone A: safe task ownership on one node

Phases 0–2 plus the single-node portions of Phases 4–5. Task isolation, durable IDs, local/shared separation, and non-destructive session attachment work before live synchronization expands the failure modes.

### Milestone B: shared interfaces and reliable history

Phases 3, 6 and 7, plus browser routing needed for a second interface. Validate quorum behavior, cached history, local layout, history modal and concurrent interaction. Existing tasks keep operating during a catalog outage.

### Milestone C: portable work with safe cleanup

Complete Phases 4, 8 and 9. Prove local-only Git replication, transfer fencing, accurate cleanup previews and restoration. Do not offer a move button backed only by best-effort directory copying.

### Milestone D: full-platform rollout

Complete Phases 10–11 and all platform tests. Turn on mandatory network onboarding only when existing data has a tested migration and recovery path. Update documentation and remove obsolete whole-config shared writes.

The feature is complete when a task can be created on one device, viewed and controlled from two independent interfaces, moved manually without losing supported work, cleaned up safely, and revisited from retained history. Coordinator failure must not corrupt catalog state, executor failure must not trigger unintended execution elsewhere, and no migration may silently delete original data.

## 7. Documentation and follow-up implementation notes

Update these existing documents as their behavior changes:

- `docs/architecture/overview.md`, `backend.md`, `renderer.md`, and `shared-models.md` for ownership, storage, task identity and headless startup.
- `docs/features/remote-connectors.md` for enrollment, protocol compatibility, quorum behavior, authentication and browser routing.
- `docs/features/project-groups.md` and `tab-system.md` for the task model and legacy group migration.
- `docs/features/pi-agent-pane.md`, `terminal.md`, and `git-manager.md` for attachment, shared input, transfer and cleanup guarantees.
- `docs/adding-pane-types.md` so future panes receive task context and cannot bypass executor routing.
- `docs/maintenance.md` for network backups, membership changes, migration recovery, replica verification and restoring a cleaned task.

Keep follow-up work scoped to these requirements. Do not add automatic scheduling, transparent process migration, a distributed working filesystem, multi-user permissions, shared credentials, or AI-authored conversation rewriting under this project.
