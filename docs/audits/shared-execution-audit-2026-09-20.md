# Shared-execution implementation audit

Audit date: September 20–21, 2026. User-facing incident times below use America/Detroit (EDT); database timestamps explicitly marked UTC are four hours ahead.

Scope: checkout `41b9732` on `feature/shared-execution`, especially the large refactor `e6c16c8` and subsequent repairs. Compared implementation against `SHARED_EXECUTION_IMPLEMENTATION_PLAN.md`, the Phase 0 baseline/ADR, existing tests, deployment instructions, live diagnostics, and read-only database/service observations across the five documented devices.

**Conclusion:** The small errors are symptoms of incomplete boundaries between the legacy workspace UI, replicated catalog, executor runtime, and local preferences. There are also substantive durability defects underneath the UI. Fixing individual error messages will not resolve those defects. Keep OpenRaft and the task/executor ownership model, but repair the state-machine snapshot contract, mutation/retry contract, event delivery, and history replication before adding more compatibility patches.

## Resolution — September 21, 2026

The stabilization implementation following this audit repairs the identified runtime boundaries:

- Catalog snapshots now serialize and transactionally restore consensus-owned relational projections, operation receipts, migration receipts, and tombstones. Device-local routing credentials, worktree paths, event-delivery progress, and preferences remain excluded.
- Successful forwarded commands wait for their local operation receipt before dependent reads. Revision-conflict attempts are retryable under the same semantic operation ID, and already-achieved lifecycle transitions return the authoritative result.
- Shared panes use task-local focus and catalog pane mutations instead of legacy whole-config writes. Legacy geometry is pruned against live catalog membership and catalog session metadata wins over imported metadata.
- Peer relay events use the common native/connector fanout. Relay subscriptions are identity-only, deduplicated, and bounded; durable event logging survives broadcast lag.
- Peer failures retain target, method, HTTP status, and body classification. Authenticated peer RPC has a scoped 8 MiB limit for validated image-bearing history records.
- History delivery is fair across failed records, maintains per-peer receipts, backfills newly connected peers, accepts retained historical task/pane records, preserves conversations across executor generations, and filters by session identity.
- A new Pi pane always starts a new conversation. Resume remains explicit and the resulting session identity is persisted to the pane catalog before subsequent attachment.
- Existing Git replicas refresh their source namespace before resolving a task base. The immutable base receipt is resolved from that refreshed namespace.
- Open interfaces reconcile catalog state on focus, visibility changes, and a five-second fallback interval. Completion is idempotent, the mounted completed task stays visible, and an explicit Resume action reactivates it.
- Cleanup previews are idempotent. Cleanup accepts either verified remote retention or configured-base integration plus majority replica receipts, checks the correct ref direction, establishes a shared lifecycle execution fence before deletion, and all executor entry points honor cleanup/transfer fences.
- Desktop configuration uses the same injected runtime data directory as the catalog and executor runtime.

Regression coverage includes relational snapshot installation, session/generation history selection, shared-pane projection pruning and metadata replacement, plus the complete existing frontend and Rust suites. Deployment validation is recorded in the implementing commit and rollout logs rather than embedding device credentials or service output in this audit.

No application implementation, production database, service configuration, deployment, or Git branch was changed. This audit adds documentation only. Additional executable probes ran against temporary copies or extracted pure functions, outside the checkout.

## Evidence and limits

- The user primarily encounters these errors on this Mac. The shared frontend paths also affect other frontends, but no claim is made that every finding was interactively reproduced on every platform.
- Existing Mac Diagnostics contained `error decoding response body` at **10:53:34 PM**, following a click on `span.h-2`, and `{"code":"revision_conflict","message":"revision_conflict"}` at **10:53:39 PM**, following **Complete**. Diagnostic interaction labels are temporal context, not definitive request tracing.
- All three coordinator databases contained the matching lifecycle rejection at **2026-09-21 02:53:39 UTC**, with expected task revision **5**. The coordinator's task was already revision **6**, lifecycle **completed**. The Mac still held revision **5**. This is concrete stale-state evidence, not merely a conjectured concurrency race.
- During inspection, Scythe's connector endpoint returned **HTTP 502 with an empty body**. There was no `swath` process or listener on port 7878; its headless service was inactive, consistent with its GUI-owned deployment policy. This establishes a current failure path for the decoding error, though there was no timestamped HTTP trace of the exact 10:53:34 request.
- Linux deployed-commit markers on all four machines were `fc0cff174b10e0dc52bfbd4ce92e4d535d064e59`, one commit behind this checkout. Markers are deployment records, not binary attestations. The Mac executable's precise source revision was not established. Findings were checked against current source, and historical log failures are identified separately.
- Mac SQLite reads used `mode=ro`; remote SQLite reads also used read-only connections. No credential values, conversation content, or raw database copies are included in this report.

### Storage observations

These are point-in-time counts, not an atomic distributed snapshot.

| Observation | Value |
| --- | ---: |
| Mac history outbox records | 8,477 |
| Mac unpublished history records | 6,755 |
| Aggregate recorded history delivery attempts | 192,916 |
| Pending records failing the current local task/pane/generation scope predicate | 1,963 |
| Such invalid records among the first 64 selected by the worker | 64 of 64 |
| Attempts per record in that first batch | 2,961–3,072 |
| Pi history records on power-server / PiTwo / Scythe / server-two | 0 / 0 / 0 / 0 |
| Largest individual history outbox payload | 2,492,087 bytes |
| History payloads larger than 2 MiB | 1 |

The Mac database was approximately 212 MB. Its largest tables occupied approximately 80.5 MB for `transactional_outbox`, 77.4 MB for `pi_session_records`, and 28.0 MB for `pi_session_attachments`. These numbers demonstrate repeated storage of large history payloads; they do not by themselves establish that a copy is unnecessary.

The Mac's durable Raft snapshot advertised index **4333** with **zero `data` keys**, despite its database containing **109 pane rows**. Power-server's snapshot advertised index **4349**, also with zero `data` keys. Their observed applied states were index 4344/term 1 on the Mac versus index 4413/term 15 on power-server. This is consistent with significant catalog divergence; a single sample cannot establish its full history or sole cause.

## Findings

P1 means a defect that should block treating shared execution as reliable: durability, wrong execution/history context, or a core workflow failure. P2 means a significant correctness or usability defect that should be repaired in the stabilization work. “Confirmed” distinguishes observed behavior or an executable probe from a code-traced failure condition. Not all listed risks have caused observed data loss.

### F01 — P2: Activating a Pi pane still attempts a forbidden legacy config save

**Evidence:** [PiAgentPane.tsx:408](/Users/dark/Custom-Apps/Swath/src/renderer/features/tabTypes/piAgent/PiAgentPane.tsx:408), [appActions.ts:38](/Users/dark/Custom-Apps/Swath/src/renderer/app/appActions.ts:38), [config.rs:225](/Users/dark/Custom-Apps/Swath/src-tauri/src/config.rs:225).

The Pi frame's activation handler unconditionally calls `appActions.setActivePane`, then additionally calls the task store's `setFocusedPane`. The first call clones and commits the legacy `AppConfig`, invokes `config.save`, and rejects once any legacy import is complete. The inspected Mac has seven completed import operations. The backend's exact rejection is `legacy whole-config writes are not supported after catalog migration`.

**Trigger/impact:** Click into a shared Pi pane. The intended local focus change also generates a rejected save. Split controls, pane actions, and settings still using `withConfig` have the same incompatible persistence boundary. Because shared projections use synthetic workspace IDs, some actions additionally mutate no matching workspace at all. Settings can change in memory and disappear after restart.

**Status:** Directly traced current-code cause for the reported class of save error; the existing Diagnostics tail did not retain that exact save incident. Do not confuse this message with the separate catalog `revision_conflict`.

**Repair direction/test:** Give task panes explicit local layout/focus actions and a supported settings store. Mount a migrated task pane, focus it, change a split, and save settings; assert no legacy config write occurs and valid local changes survive reload.

### F02 — P1: Mutations build preconditions from stale local catalog state

**Evidence:** [tasks/mod.rs:138](/Users/dark/Custom-Apps/Swath/src-tauri/src/tasks/mod.rs:138), [tasks/mod.rs:538](/Users/dark/Custom-Apps/Swath/src-tauri/src/tasks/mod.rs:538), [network/raft/mod.rs:1523](/Users/dark/Custom-Apps/Swath/src-tauri/src/network/raft/mod.rs:1523), [TaskWorkspace.tsx:455](/Users/dark/Custom-Apps/Swath/src/renderer/features/tasks/TaskWorkspace.tsx:455).

Mutation handlers read the expected revision from local SQL. `client_write` forwards that already-built request to the leader without waiting for the local replica to catch up. `listCatalog` also returns local SQL rows, without a consistency watermark. Therefore clicking Complete, renaming, or creating panes from a lagging node can fail even when the user has no competing edit.

**Observed:** The Complete incident submitted revision 5 while the coordinators already held revision 6/completed. The UI did not reconcile the already-achieved result; it surfaced raw JSON. Immediate refreshes after forwarded writes also have no read-your-write guarantee. Multi-step creation is exposed because provisioning reads the newly created task back from local SQL immediately after a forwarded commit.

**Repair direction/test:** Define a consistent command/read contract: obtain authoritative preconditions or wait for an applied-index receipt before dependent reads. For an already-completed task, return its authoritative state. Preserve real conflict detection for user edits. Test commands through a deliberately delayed follower, including the second step of task provisioning.

### F03 — P1: Raft snapshots do not contain or restore the relational catalog

**Evidence:** [network/raft/mod.rs:301](/Users/dark/Custom-Apps/Swath/src-tauri/src/network/raft/mod.rs:301), [network/raft/mod.rs:1111](/Users/dark/Custom-Apps/Swath/src-tauri/src/network/raft/mod.rs:1111), [network/raft/mod.rs:1210](/Users/dark/Custom-Apps/Swath/src-tauri/src/network/raft/mod.rs:1210).

Snapshots serialize `State.data`, the legacy `Put/Delete` map. Modern Project/Task/Pane/etc. entries update relational SQL tables instead of that map. Snapshot installation writes Raft metadata and the map, but never restores projects, tasks, panes, deduplication receipts, tombstones, or the other replicated projections.

**Trigger/impact:** A fresh learner or a lagging node that catches up using a snapshot can report an applied Raft index while its actual catalog is missing or stale. Compaction removes the ability to recover omitted rows merely by replaying the retained suffix. Old local records also survive because snapshot installation does not replace the catalog tables.

**Confirmed probe:** Snapshot a store containing one project, install it into a fresh store, query projects: **zero rows**. Existing snapshot/failover tests mainly exercise legacy `Put` values, which explains why they pass. The production snapshot observations above independently confirm empty map payloads.

**Repair direction/test:** Make snapshots transactionally cover the complete replicated state and receipts, while excluding executor-local credentials/preferences/runtime state. Validate fresh-node installation, tombstones, dedupe, subsequent mutations, restart, and compaction using real Project/Task/Pane commands. This needs a recovery plan for existing divergent databases, not only a serializer change.

### F04 — P1: Stable operation IDs become conflicts when callers retry with a new revision

**Evidence:** [network/raft/mod.rs:363](/Users/dark/Custom-Apps/Swath/src-tauri/src/network/raft/mod.rs:363), [network/raft/mod.rs:514](/Users/dark/Custom-Apps/Swath/src-tauri/src/network/raft/mod.rs:514), [tasks/mod.rs:573](/Users/dark/Custom-Apps/Swath/src-tauri/src/tasks/mod.rs:573), [PiAgentPane.tsx:157](/Users/dark/Custom-Apps/Swath/src/renderer/features/tabTypes/piAgent/PiAgentPane.tsx:157).

The deduplication hash includes `(kind, expected_revision, payload)`. Task handlers recompute the revision each time they receive an operation ID. Pi session updates reuse `pane-session:<pane>:<session>` across mounts. A successful update followed by the same semantic update at the now-current revision becomes `operation_id_conflict`. A stored revision-conflict result also remains a conflict for an exact retry; rebasing under the same ID changes its hash.

**Confirmed probe:** Apply the same project update with one stable ID at revision 1, then retry it at revision 2. Results: `committed`, then `operation_id_conflict`.

**Impact:** Retrying after a lost response, switching panes, or recovering from F02 can create permanent-looking failures. Create operations also generate new entity IDs on each handler invocation, so accepting an optional operation ID is not sufficient to make the domain operation retry-safe.

**Repair direction/test:** Separate semantic operation identity from immutable execution attempts/preconditions. Persist and recover command receipts before regenerating IDs or revisions. Do not blindly retry conflicting user intent. Cover lost-response retries, precondition rejection/rebase, and repeated session-state observations.

### F05 — P1: Relayed executor events miss the native Tauri frontend

**Evidence:** [lib.rs:92](/Users/dark/Custom-Apps/Swath/src-tauri/src/lib.rs:92), [remote.rs:1353](/Users/dark/Custom-Apps/Swath/src-tauri/src/remote.rs:1353), [remoteAdapter.ts:267](/Users/dark/Custom-Apps/Swath/src/renderer/platform/remoteAdapter.ts:267).

Local executor events use `Core.events`, a fanout to both Tauri and connector subscribers. Peer-relayed terminal/Pi/Git events instead call `ctx.events.publish`, which is only `ConnectorEvents`. Shared native requests route through the local backend; their event listeners still listen to Tauri. The legacy remote clients in the hybrid adapter only cover explicitly configured legacy profiles and do not bridge this general shared-task route.

**Trigger/impact:** Execute a task on another device from the native app without an independently subscribed legacy connection to that executor. RPC requests can succeed while terminal output/Pi responses never reach the native pane. A browser attached to the serving connector has a different delivery path and may work.

**Status:** Confirmed wiring defect by code trace, not an end-to-end live execution test; Scythe was offline during this audit.

**Repair direction/test:** Route local and relayed events through a single, source-aware publisher to all appropriate local consumers. Test a native-style listener against a remote executor, including terminal replay, Pi handshake responses, exit, and reconnect.

### F06 — P2: Empty/non-JSON peer failures turn into “error decoding response body”

**Evidence:** [remote.rs:1395](/Users/dark/Custom-Apps/Swath/src-tauri/src/remote.rs:1395).

`peer_call` captures the HTTP status, then unconditionally calls `response.json()` before handling failure status. Empty 502 responses and plaintext proxy errors consequently lose the useful transport diagnosis. The resulting error omits target device, method, status, and body category.

**Observed:** Scythe returned an empty HTTP 502 during inspection. Existing Diagnostics retained the exact generic decoding error. This is a strong explanation of that incident class; the original request itself was not recorded.

**Repair direction/test:** Decode a bounded body after preserving status and endpoint context. Return a typed executor-unavailable error for empty/non-JSON failures, and a protocol error for malformed successful responses. Test empty 502, plaintext 413, JSON 401, and malformed 200 separately.

### F07 — P1: History replication can permanently starve behind 64 undeliverable records

**Evidence:** [runtime.rs:117](/Users/dark/Custom-Apps/Swath/src-tauri/src/runtime.rs:117), [pi_session_store.rs:319](/Users/dark/Custom-Apps/Swath/src-tauri/src/pi_session_store.rs:319).

Every pass selects the oldest 64 unpublished records. A record is published only after delivery to every connector. There is no per-destination scheduling, retry eligibility time, poison-record isolation, or progress past a permanently blocked first batch. `sync_apply` rejects history unless the task and pane are currently live and the generation equals the task's current generation.

**Observed:** All first 64 pending Mac records fail that same local scope predicate; they date from September 19 and have thousands of attempts each. Thousands of newer records remain pending. All four Linux history stores were empty at inspection. The measurements do not prove every delivery failed for the same reason, but the starvation mechanism and invalid first batch are concrete.

**Impact:** Deleting a task/pane, moving execution to a new generation, or leaving a connector unavailable can block replication of unrelated chats. New peers also have no obvious historical backfill path for already-published rows: incoming `sync_apply` records are not themselves put in the delivery outbox.

**Repair direction/test:** Track per-peer progress independently; fairly schedule eligible batches; retain and diagnose permanent failures; allow authenticated historical records under an explicit retained-history policy. Add peer bootstrap/anti-entropy. Test deletion, ownership transfer, an offline peer, and a newly joined peer while other chats continue replicating.

### F08 — P1: Legitimate history/image payloads exceed the peer endpoint body limit

**Evidence:** [remote.rs:350](/Users/dark/Custom-Apps/Swath/src-tauri/src/remote.rs:350), [remote.rs:1463](/Users/dark/Custom-Apps/Swath/src-tauri/src/remote.rs:1463), [runtime.rs:144](/Users/dark/Custom-Apps/Swath/src-tauri/src/runtime.rs:144).

Peer RPC uses Axum's `Json` extractor without a route-specific body limit. The installed Axum source documents its default as 2 MiB. The replication worker embeds one full event, including image data, into a JSON peer request. The inspected outbox already contains a **2,492,087-byte** individual payload, larger than the limit even before envelope overhead.

**Trigger/impact:** Replicate a sufficiently large image-bearing message. Extraction rejects it before application handling; it remains retryable forever and contributes to F07. Other large JSON RPCs may encounter the same ceiling, but those were not measured here.

**Repair direction/test:** Define bounded attachment transfer separately from event metadata, or explicitly support validated chunking/limits appropriate to these routes. Test the largest supported image and failures just beyond the limit; do not simply disable every request limit globally.

### F09 — P1: History selection mixes sessions and discards pre-transfer generations

**Evidence:** [piHistoryCache.ts:67](/Users/dark/Custom-Apps/Swath/src/renderer/features/tabTypes/piAgent/piHistoryCache.ts:67), [usePiAgent.ts:399](/Users/dark/Custom-Apps/Swath/src/renderer/features/tabTypes/piAgent/usePiAgent.ts:399), [pi_session_store.rs:319](/Users/dark/Custom-Apps/Swath/src-tauri/src/pi_session_store.rs:319).

History cache keys contain session ID and execution generation, but `applyPiHistory` filters only task, pane, and generation. It ignores the record's session ID. Conversely, it excludes every record from a preceding execution generation even when that history belongs to the same moved task. Backend sync acceptance imposes the same current-generation restriction on late deliveries.

**Confirmed pure-function probe:** For a session-A/generation-2 cache, a session-B/generation-2 record is included while a session-A/generation-1 record is excluded.

**Impact:** Reusing a pane for another conversation can mix transcripts. After transfer, read-only/offline history can omit the earlier conversation even if its records still exist. A live Pi session file may mask the omission, so this is not a claim that files themselves were deleted.

**Repair direction/test:** Define conversation identity independently from executor epochs, explicitly connect session branches, and use a stable cross-source ordering. Test session switching and a conversation spanning an ownership transfer with no running executor available.

### F10 — P1: Legacy projection overrides shared pane membership and session metadata

**Evidence:** [TaskWorkspace.tsx:24](/Users/dark/Custom-Apps/Swath/src/renderer/features/tasks/TaskWorkspace.tsx:24), [TaskWorkspace.tsx:383](/Users/dark/Custom-Apps/Swath/src/renderer/features/tasks/TaskWorkspace.tsx:383).

When a legacy workspace exists, projection copies all its old views and only remaps leaf IDs. It does not prune absent shared panes or replace their metadata with authoritative `TaskPane.sessionId`. The completed-task filter is applied to the input pane list, but all legacy views are then reintroduced. Legacy `activePaneId` values are also not remapped with the leaf IDs.

**Confirmed probes:** A shared pane with `/new/session.jsonl` still renders `/old/session.jsonl`; an empty shared pane list still renders the legacy pane.

**Impact:** Deleted panes remain visible, Pi resumes stale paths, session-update effects keep seeing mismatches, and transcript-only historical projection can contain old terminal/Git/file views. This combines particularly badly with F04. Native pane controls still expect legacy workspace identities, as in F01.

**Repair direction/test:** Import geometry once into local layout storage. Project only live shared pane IDs, obtaining metadata from the catalog. Test pane deletion, changed session ID, remapped focus, and completed tasks with legacy mixed-pane splits.

### F11 — P1: A new Pi pane can continue an existing sibling's conversation

**Evidence:** [tasks/mod.rs:565](/Users/dark/Custom-Apps/Swath/src-tauri/src/tasks/mod.rs:565), [usePiAgent.ts:255](/Users/dark/Custom-Apps/Swath/src/renderer/features/tabTypes/piAgent/usePiAgent.ts:255), [0001-shared-execution-phase-0.md](/Users/dark/Custom-Apps/Swath/docs/decisions/0001-shared-execution-phase-0.md).

`createPane` creates a Pi pane without a session ID or initial-start metadata. On spawn, the hook chooses `--continue` whenever there is no stored session and no initial prompt. All panes in a task share a working directory. The repository's Pi contract documents continuation of the existing project session.

**Trigger/impact:** Create a second Pi chat in a task that already has session history. Its default launch asks to continue the previous session instead of explicitly starting a new conversation. Distinct pane IDs do not prevent two processes from selecting the same underlying session file.

**Status:** Code-traced launch contract; no live prompt or Pi session was created during this audit.

**Repair direction/test:** Make “new chat,” “resume chat,” and “fork chat” explicit executor operations. Allocate session identity at creation and persist it before attachment. Test two Pi panes in one task and verify different session IDs/files unless the user explicitly requests a fork or continuation.

### F12 — P1: New tasks can silently start from an outdated branch tip

**Evidence:** [tasks/mod.rs:32](/Users/dark/Custom-Apps/Swath/src-tauri/src/tasks/mod.rs:32), [tasks/mod.rs:298](/Users/dark/Custom-Apps/Swath/src-tauri/src/tasks/mod.rs:298), [git.rs:778](/Users/dark/Custom-Apps/Swath/src-tauri/src/git.rs:778).

`ensure_local_replica` immediately returns if the replica directory already exists. `create_task` resolves the selected ref inside that replica, then passes the replica as both source and destination store. Provisioning consequently skips refreshing the original repository. Furthermore, the refresh helper fetches into `refs/swath/source/*`, while a short `main` ref can still resolve to the initially cloned local branch.

**Confirmed isolated Git probe:** Initialize source/main, create the private replica, advance source/main, call `ensure_local_replica` again. The replica's main still resolves to the first commit.

**Impact:** A task created “from main” can start from old code without an error. A new commit ID available only in the real source may be reported as an unborn repository because ref-resolution errors are collapsed into that message.

**Repair direction/test:** Resolve a clearly defined source ref after a successful refresh, then pin its immutable commit receipt. Test source branch advancement, explicit commit IDs, and unavailable source behavior. Do not silently change an already-created task's pinned base.

### F13 — P2: Shared catalog changes do not automatically reach open UIs

**Evidence:** [App.tsx:64](/Users/dark/Custom-Apps/Swath/src/renderer/App.tsx:64), [taskStore.ts:38](/Users/dark/Custom-Apps/Swath/src/renderer/state/taskStore.ts:38), [network/raft/mod.rs:522](/Users/dark/Custom-Apps/Swath/src-tauri/src/network/raft/mod.rs:522), [remote.rs:1012](/Users/dark/Custom-Apps/Swath/src-tauri/src/remote.rs:1012).

The task store refreshes at startup and selected local action completions. There is no general catalog-event subscription or periodic catalog reconciliation. Catalog writes create `catalog.*` outbox rows, but the worker consumes only `pi.history`; durable browser events cover Pi and terminal exits, not catalog changes.

**Trigger/impact:** Rename, complete, add, remove, or transfer a task from a second device. An already-open first interface can keep its old state until an incidental refresh. Executor generations and task visibility can become stale independently of the backend replica problem in F02/F03.

**Repair direction/test:** Publish committed catalog revisions with a reconnect cursor and reconcile on gaps. Use a lightweight refresh fallback. Test two viewers where only one performs a mutation, plus reconnect after missed events.

### F14 — P2: Completion/reactivation/inactivity behavior is only partially implemented

**Evidence:** [ViewTabBar.tsx:164](/Users/dark/Custom-Apps/Swath/src/renderer/features/views/components/ViewTabBar.tsx:164), [TaskWorkspace.tsx:442](/Users/dark/Custom-Apps/Swath/src/renderer/features/tasks/TaskWorkspace.tsx:442), [task_store/mod.rs:66](/Users/dark/Custom-Apps/Swath/src-tauri/src/task_store/mod.rs:66), [taskActions.ts](/Users/dark/Custom-Apps/Swath/src/renderer/domain/tasks/taskActions.ts).

The tab bar filters strictly to `lifecycle === active`, without considering running work or inactivity. `task_activity` is created but has no writers. Helper functions describing two-day hiding and reactivation are not wired into the runtime. Completed tasks become read-only, and the public task RPC dispatch has no ordinary reactivate action. Continuing a process or editing files does not update lifecycle through this mechanism.

**Impact:** A running task can disappear from normal tabs when completed; inactivity does not implement the planned behavior; history cannot naturally resume work. Restoring a cleaned worktree is a separate operation and does not fill this everyday lifecycle gap.

**Repair direction/test:** Centralize activity updates at accepted execution/mutation boundaries. Keep viewing separate. Define completion while work is running, and expose explicit resume behavior. Test running completion, two-day inactivity, and work on a completed task.

### F15 — P2: Opening an unchanged cleanup preview twice causes a unique-key error

**Evidence:** [transfer_cleanup.rs:1415](/Users/dark/Custom-Apps/Swath/src-tauri/src/tasks/transfer_cleanup.rs:1415).

The preview token is a deterministic hash of preview data. `cleanup_preview` unconditionally inserts an operation whose primary key is `cleanup-<token>`. There is no conflict handler or reuse of an existing identical preview.

**Trigger/impact:** Open Cleanup, close it, and reopen without changing worktree/ref/process/receipt evidence. The same token can produce `UNIQUE constraint failed: task_operations.operation_id`; the frontend does not catch that rejection. The determinism makes this a normal retry path, not exceptional input.

**Repair direction/test:** Treat an identical valid preview as an idempotent read/receipt operation, and create a new receipt only for changed evidence. Test two consecutive previews against the same managed worktree.

### F16 — P2: Cleanup cannot handle the promised local-only repository workflow

**Evidence:** [transfer_cleanup.rs:1291](/Users/dark/Custom-Apps/Swath/src-tauri/src/tasks/transfer_cleanup.rs:1291), [transfer_cleanup.rs:1478](/Users/dark/Custom-Apps/Swath/src-tauri/src/tasks/transfer_cleanup.rs:1478), [git.rs:870](/Users/dark/Custom-Apps/Swath/src-tauri/src/git.rs:870).

Cleanup requires `remoteFresh` unconditionally. `remote_evidence` returns false without both origin and an upstream branch. Newly provisioned task branches are created without establishing that upstream, and local-only repositories intentionally need no external remote. Majority replica receipts therefore cannot substitute for remote evidence as the plan requires.

The `unmerged` calculation, `git log --all --not HEAD`, also measures commits elsewhere that HEAD cannot reach, not task commits unmerged into the project's configured main/base branch. An unrelated branch can block cleanup; this is not the intended integration check.

**Impact:** Legitimate retained local-only tasks, and ordinary task branches lacking upstreams, fail cleanup safety checks. The UI also never supplies the backend's `discardApproval` option, so intentional loss approval is not available there.

**Repair direction/test:** Model independent retention paths: verified remote retention, or integration into the configured local base plus replica receipts. Compare the correct ref direction. Test a local-only project, a fresh task branch, and an unrelated side branch.

### F17 — P1: Cleanup's freeze does not fence execution, and deletion precedes catalog authorization

**Evidence:** [transfer_cleanup.rs:1500](/Users/dark/Custom-Apps/Swath/src-tauri/src/tasks/transfer_cleanup.rs:1500), [pi_agent.rs:506](/Users/dark/Custom-Apps/Swath/src-tauri/src/pi_agent.rs:506), [terminal.rs:482](/Users/dark/Custom-Apps/Swath/src-tauri/src/terminal.rs:482), [remote.rs:1734](/Users/dark/Custom-Apps/Swath/src-tauri/src/remote.rs:1734).

The dispatcher stops existing children, then cleanup validates state and marks a local `cleanup frozen` operation. Execution guards only check **transfer** operations in specific phases. Another viewer can therefore reopen a Pi/terminal process or mutate during cleanup. The worktree is force-removed before the cleanup catalog write succeeds. On catalog failure, compensation only attempts to recreate the retained commit and ignores restoration failure; it cannot reconstruct discarded uncommitted files.

**Trigger/impact:** Concurrent attach/write during cleanup, or loss of quorum/conflicting revision after deletion. This is a code-traced data-loss/ambiguous-outcome risk, not an observed destructive incident. No cleanup was executed against user work.

**Repair direction/test:** Obtain durable authorization and a shared executor mutation fence before stopping/checking/deleting; verify the fence atomically at every execution entry point. Keep recoverable staged content until commit/recovery guarantees are satisfied. Fault-inject a second viewer, catalog rejection, process restart, and interrupted deletion.

### F18 — P2: Desktop config loading still ignores the configured runtime data directory

**Evidence:** [lib.rs:88](/Users/dark/Custom-Apps/Swath/src-tauri/src/lib.rs:88), [commands.rs:15](/Users/dark/Custom-Apps/Swath/src-tauri/src/commands.rs:15), [config.rs:14](/Users/dark/Custom-Apps/Swath/src-tauri/src/config.rs:14).

Core startup honors `SWATH_DATA_DIR`, but `config_load`/`config_save` use the AppHandle-based path, which always resolves Tauri's app-data directory. The newer local-state and execution commands use `Core.data_dir`. On the documented Fedora launcher, the runtime directory is explicitly overridden.

**Impact:** Settings and legacy workspace/layout source can be loaded from one database while network/catalog/task state comes from another. This makes migration projections and configuration discrepancies device-specific. The earlier runtime-directory repair does not cover this remaining path.

**Repair direction/test:** Inject the same storage context into every desktop/headless command. Launch with a temporary non-default data directory and different settings in the default directory; verify all supported configuration reads and writes use the selected location.

## Additional maintainability and resilience findings

### Event relay state grows with requests, and recovery behavior is fragile

[remote.rs:1271](/Users/dark/Custom-Apps/Swath/src-tauri/src/remote.rs:1271) sends a subscription update on every forwarded operation and appends every update to a `Vec`. Reconnect replays the entire vector. It uses an unbounded channel; an offline peer can accumulate queued requests while the connection loop never drains them. Subscription parameters include the original request object, so repeated prompt-bearing requests can retain unnecessary payload copies. Deduplicate subscriptions by actual task/pane/session identity and bound queues.

When hosting is stopped, [remote.rs:395](/Users/dark/Custom-Apps/Swath/src-tauri/src/remote.rs:395) constructs a fresh context and relay map for each native dispatch, defeating connection reuse. Keep a persistent routing/event context owned by Core rather than the HTTP listener lifecycle.

The durable event writer uses `while let Ok(event) = events.recv().await`; a broadcast lag error exits it permanently. Runtime Pi persistence errors are discarded with `let _ = record(...)`. These require explicit recovery/diagnostic tests, not larger buffers alone.

### Storage initialization performs migrations and repairs on ordinary request paths

[config.rs:37](/Users/dark/Custom-Apps/Swath/src-tauri/src/config.rs:37) executes schema setup and several migration functions whenever a connection is opened. The Pi migration repeatedly attempts an ALTER TABLE, while task-store migration runs a path-repair INSERT. Hot event/history paths open many such connections. This mixes startup upgrades, reads, and repair writes, adding lock contention and making ostensibly read-only application commands harder to reason about.

Use explicit numbered startup migrations once per database version; make normal repositories open configured connections without repair side effects. Separate compatibility recovery tools from normal reads.

### Error contracts and diagnostics obscure the operation that failed

The code alternates among `Result<Value, String>`, resolved `{ok:false, code, error}`, JSON serialized into strings, and `CatalogError {code,message}`. UI handlers frequently assume success in `.then(refresh)`, omit catches, or inspect `message` when the backend supplies `error`. This is why backend failures become “Unhandled promise rejection” instead of a recoverable operation result.

[errorLog.ts](/Users/dark/Custom-Apps/Swath/src/renderer/lib/errorLog.ts) retains only 100 in-memory entries and loses them on restart. The backend does not retain a structured request/error trail for ordinary peer calls. The service journal is useful for startup failures, but cannot reliably reconstruct these frontend incidents.

Use one typed error/result envelope, retain operation IDs through every hop, and record bounded redacted diagnostics containing method, task, target device, generation, expected/observed revision, HTTP status, and causal error. Do not log bearer credentials, prompt bodies, image data, or arbitrary response bodies.

## Architecture recommendation

This should be a staged correction of ownership boundaries, rather than another wholesale rewrite or a replacement of OpenRaft.

| Area | Current concentration/problem | Recommended boundary |
| --- | --- | --- |
| Replicated catalog | 2,098-line Raft module combines transport, state machine, schema projection, membership, receipts, and tests; snapshots cover the wrong state | Typed catalog commands and deterministic projector, complete snapshot codec, separate Raft storage/transport adapters |
| Runtime routing | 3,103-line remote module combines HTTP/WS, auth, enrollment, routing, relays, sync, preview proxy, and domain dispatch | Thin HTTP/Tauri adapters over one persistent application service and one executor router |
| Task operations | Provisioning and mutations assume local SQL freshness; generated IDs/preconditions are rebuilt on retry | Durable command receipts and explicit phase transitions; authoritative reads at defined consistency points |
| Move/cleanup | 1,654-line module implements hashing, traversal, transfer transport, Git, process checks, receipts, deletion, and recovery | Shared executor fence, operation state machine, artifact manifest/transport, independent Git retention policy |
| Renderer | 608-line TaskWorkspace plus legacy appActions and synthetic workspace projections | Native TaskView model with explicit shared-pane commands and local layout/focus store |
| Pi sessions/history | Session path, conversation identity, generation, event cache, persisted records, attachments, and delivery state overlap | Conversation/session identity service; append-only history store; attachment store; per-peer replication progress |

Raw line count is not the issue by itself. The combined boundaries cause observed defects: the same intent has multiple mutation paths, and several paths disagree about ownership and state freshness. The seven inspected core files together total **10,029 lines**, but splitting those files without changing contracts would leave the bugs intact.

The highest-value simplification is to retire active legacy mutation paths after import. Preserve old JSON as rollback evidence, import its layout into an explicit local structure, and stop reconstructing runtime state from it on every render. Avoid adding another string-ID special case or another post-write SQL patch to compensate for missing consistency guarantees.

The architecture docs are also stale: the backend/shared-model documents still describe AppConfig as the primary source of workspaces and TerminalManager as the main AppState owner. Update those documents to the repaired architecture, including which tables are replicated versus executor-local and which reads guarantee freshness.

## Suggested repair order and acceptance gates

1. **Restore catalog correctness:** F03 snapshots and existing replica reconciliation, then F02 consistency and F04 retry receipts. Gate: fresh-node snapshot plus delayed-follower create/update/delete/complete tests converge on identical catalog state.
2. **Restore basic frontend operation:** F01 legacy saves, F05 native event fanout, F06 transport errors, F10 projection, F13 live catalog updates, and F18 data-directory consistency. Gate: two native/browser viewers can attach, observe output, select panes, edit local settings, and see shared changes without incidental saves or manual reloads.
3. **Restore conversation durability:** F07/F08 replication and attachments, F09 history scope, F11 new-session creation. Gate: offline peer, deleted historical task, large image, move, restart, and new-peer backfill all retain the intended transcript without mixing chats.
4. **Correct task semantics and filesystem operations:** F12 source freshness, F14 lifecycle, F15–F17 cleanup. Gate: explicit base receipts, correct running/history behavior, repeatable previews, local-only retention, and failure-injected deletion recovery.
5. **Simplify and instrument:** Extract the boundaries above as they are repaired, add redacted diagnostics, and move schema migrations off hot paths. Avoid a cosmetic file-splitting phase that leaves the same contracts in place.

Until these gates pass, successful compilation and healthy coordinator status are insufficient evidence that shared execution is reliable.

## Validation performed

| Check | Result |
| --- | --- |
| TypeScript `npm run typecheck` | Passed |
| Existing frontend unit suite | 41 files, 249 tests passed |
| Existing Rust headless library suite | 70 tests passed |
| Isolated snapshot probe | Confirmed relational project omitted on snapshot installation |
| Isolated operation retry probe | Confirmed same successful intent at rebased revision becomes operation-ID conflict |
| Isolated Git replica probe | Confirmed existing replica resolves old main after source advances |
| Pure projection probes | Confirmed stale session metadata and removed-pane retention |
| Pure history probe | Confirmed other-session inclusion and previous-generation exclusion |
| Live UI Diagnostics | Read existing decoding and revision-conflict incidents; closed settings afterward |
| Read-only database inspection | Mac plus all four documented Linux devices |
| Connector/process inspection | Scythe empty 502, no Swath process/listener; no service restart |

The isolated probes assert the **currently defective behavior** to demonstrate it; they are not acceptance tests claiming correctness. Probe workspace: `/tmp/swath-shared-execution-audit`. Test output files: `/tmp/swath-audit-unit.log`, `/tmp/swath-audit-rust.log`, `/tmp/swath-audit-probes.log`.

No live task creation, Pi submission, migration, transfer, cleanup, deployment, destructive fault injection, or Windows execution was performed. Cleanup and event-routing risks remain code-traced findings where stated. A failed exploratory Vite SSR probe was replaced with direct pure-function extraction/bundling; it did not change application code.

## Historical log findings, separated from current defects

- Power-server's September 19 service journal contained a repeated `UNIQUE constraint failed: raft_node_members.network_id, raft_node_members.node_id` startup failure, reaching restart counter 62 before the later restart succeeded. The intervening identity-related commits address this area. This is evidence of the rollout's instability, not a claim that the current exact startup bug remains unfixed.
- On September 20 at 03:00:52, power-server failed to enable Tailscale Serve with `unexpected state: NoState`; systemd retried. Network readiness during boot deserves a startup retry test, but this single historical failure was not conflated with current Pi errors.
- The coordinator journals after the later deployments did not provide the user's UI-level errors. Scythe's broad journal included unrelated Chromium messages, which were excluded from findings. The exact lifecycle rejection was recoverable from operation receipts instead.

The root causes with the strongest evidence are F01/F02/F06 for the visible errors, F03 for catalog recovery, and F07–F09 for history reliability. Address those shared mechanisms before treating the remaining symptoms as independent small bugs.
