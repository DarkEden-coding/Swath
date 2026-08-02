# Pi Agent pane — implementation plan

A dedicated `piAgent` tab type that drives the [pi coding agent](https://github.com/earendil-works/pi) through
its headless JSON-RPC protocol and renders the conversation with native React components, replacing the TUI.

Status: **implemented.** See §9 for what is built and what remains unverified.

---

## 1. Decisions taken

| Question | Decision |
|---|---|
| Visual fidelity | Match the TUI design closely, but with real GUI elements — scrollable regions, click-to-expand, selectable text, syntax-highlighted diffs. |
| Extension coverage | All of them, unified into one UI surface. |
| Session management | Full tree navigation — resume, fork, clone, visual branch tree. |
| Process model | Dedicated tab, one `pi --mode rpc` child process per tab, over pipes. |
| Theming | App's existing theme for chrome; extension content already carries its own ANSI colors. |
| Composer | Image paste/drag-drop, `@file` mentions with completion, model + thinking switchers. Follow-up only, no steering. |
| Tool rendering | One generic ANSI card + a diff viewer. Per-tool renderers only where the generic one falls short. |
| Delivery | Full plan, built straight through. |
| Libraries | `marked` + `prism-react-renderer`; ANSI parser hand-written. |

---

## 2. Protocol foundation (verified live)

`pi --mode rpc` speaks strict JSONL over stdin/stdout. Verified against the real config at
`~/.pi/agent` — a handshake of `get_state` + `get_commands` returned complete, well-formed data.

Reference docs ship with the package:
`/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/docs/{rpc,extensions,sdk,session-format}.md`

### 2.1 What we get for free

Commands: `prompt`, `steer`, `follow_up`, `abort`, `new_session`, `get_state`, `get_messages`,
`set_model`, `cycle_model`, `get_available_models`, `set_thinking_level`, `get_available_thinking_levels`,
`set_steering_mode`, `set_follow_up_mode`, `compact`, `set_auto_compaction`, `set_auto_retry`,
`abort_retry`, `bash`, `abort_bash`, `get_session_stats`, `export_html`, `switch_session`, `fork`,
`clone`, `get_fork_messages`, `get_entries`, `get_tree`, `get_last_assistant_text`,
`set_session_name`, `get_commands`.

Events: `agent_start/end/settled`, `turn_start/end`, `message_start/update/end`,
`tool_execution_start/update/end`, `bash_execution_update`, `queue_update`,
`compaction_start/end`, `auto_retry_start/end`, `summarization_retry_*`, `extension_error`.

### 2.2 What extensions emit over RPC

Extensions reach the UI through an `extension_ui_request` sub-protocol. A live handshake with the
current config produced exactly the surfaces visible in the reference screenshot:

```json
{"method":"setWidget","widgetKey":"chat-banner-stats","widgetLines":["[38;2;80;137;220mTools:[39m 0 …"],"widgetPlacement":"belowEditor"}
{"method":"setWidget","widgetKey":"background-terminal-count","widgetLines":["[38;2;100;116;139mbackground terminals: 0[39m"]}
{"method":"setStatus","statusKey":"parallel-agents","statusText":"[38;2;100;116;139msubagents:5/5[39m"}
{"method":"notify","message":"Context7 extension loaded.","notifyType":"info"}
```

Two categories:

- **Fire-and-forget** — `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`.
  Payloads are ANSI-colored strings. One generic renderer covers every current *and future* extension.
- **Dialogs** — `select`, `confirm`, `input`, `editor`. Emit a request with an `id` and block until
  we send `extension_ui_response` with a matching `id`. Optional `timeout` auto-resolves agent-side.

### 2.3 What does *not* survive RPC — this is the actual work

In RPC mode `ctx.ui.custom()` returns `undefined`, and `setFooter`, `setHeader`,
`setWorkingMessage`, `setWorkingIndicator`, `setEditorComponent`, `setToolsExpanded` are no-ops.
`getTheme()`/`getAllThemes()` return nothing.

`tool-cards.ts` produces the boxed cards in the screenshot by monkey-patching
`ToolExecutionComponent.prototype.render` inside the TUI. **None of that reaches RPC.** So these must
be re-implemented natively in React:

- Tool card chrome — border box, `⏱ timeout 60s`, `✓ Completed`, `⏱ Took 1.1s`, `… 3 more lines · ctrl+o expand`.
- Diff rendering from `pi-diff` structured payloads (`_type: "editInfo" | "multiEditInfo"`).
- pi's footer block — `~/.pi/agent (main)`, `↑149k ↓22k R3.7M CH99.4% $1.615 (sub) 50.0%/272k (auto)`,
  `(openai-codex) gpt-5.6-terra • medium`. Rebuilt from `get_state` + `get_session_stats`.

**Verified: structured tool results *do* survive.** `rpc.md` (971–1016) confirms
`tool_execution_end` serializes `result.details`, so `pi-diff`'s `editInfo`/`multiEditInfo` payload
reaches the renderer intact — the diff viewer can render from structured data rather than
reconstructing diffs from `old_string`/`new_string` args.

Also verified: `tool_execution_update.partialResult` carries **accumulated** output, not deltas —
replace-on-update. The same turns out to be true of messages (§2.4), so nothing in the stream
needs delta accumulation.

Timing (`Took 1.1s`) comes from `tool_execution_start`/`end` timestamps — no extra work. (`tool-cards.ts`
also persists it as `reference-tool-cards.timing-v1` entries readable via `get_entries`, but that
only matters for replayed history; skip it.)

### 2.4 Message events carry whole messages, not deltas

Captured from a real turn (`piAgent/fixtures/turn.jsonl`, used as the reducer's test fixture).
The docs' outline is easy to misread here, and the naive reading is wrong:

- `message_start` / `message_update` / `message_end` all carry a **complete** `message` object.
  `message.content` is cumulative, so consumers **replace** — accumulating deltas double-counts.
- Messages have **no id**. Updates target the single open message positionally.
- `message_update` also carries `assistantMessageEvent` (`text_delta`, `thinking_delta`,
  `toolcall_delta`, …). It is redundant with `message` for rendering purposes.
- `role` is one of `user`, `assistant`, `toolResult`, `bashExecution`. A tool call produces
  **four** message pairs per turn: user, assistant (with a `toolCall` block), toolResult, assistant.
- `toolCall` blocks inside assistant content and the `toolResult` messages both duplicate the
  `tool_execution_*` events. Render tools from `tool_execution_*` only, and skip both, or every
  tool appears three times.
- Assistant messages carry `usage` (tokens + cost) — the footer stats source.

### 2.5 Extension inventory

Scanned `~/.pi/agent/extensions` for TUI-only vs RPC-visible API usage:

| Extension | TUI-only hooks | RPC-visible hooks | Notes |
|---|---|---|---|
| `parallel-agents.ts` (55 KB) | 0 | 33 | Centerpiece. Fully drivable over RPC. |
| `memories.ts` | 1 | 25 | Pure dialogs — see §2.7. |
| `background-terminals.ts` | 1 | 10 | Widget + tool. |
| `todo.ts` | 1 | 9 | Pure dialogs — see §2.7. |
| `clipboard-image-paste.ts` | 0 | 6 | Emits attached-images widget. |
| `tool-cards.ts` | 0 (patches prototypes) | 6 | Presentation must be re-implemented. |
| `track-edits.ts` | 0 | 6 | `/open-changes`. |
| `brave-search.ts` | 1 | 4 | |
| `context7-search.ts` | 0 | 4 | |
| `banner-stats.ts` | 0 | 3 | Widget only — free. |
| `continue.ts` | 0 | 2 | |
| `exa-search.ts` | 0 | 1 | |
| `user-query.ts` | 1 | 1 | |
| `optimize-grep.ts` | 0 | 0 | Transparent. |

Plus npm packages: `pi-cursor-sdk` (9 commands), `pi-fff` (3), `@heyhuynhgiabuu/pi-pretty`,
`@heyhuynhgiabuu/pi-diff`, `@netandreus/pi-cursor-provider`.

`get_commands` returns all 25 slash commands with descriptions and source metadata — that response
*is* the spec for the command palette, so the palette needs no per-extension knowledge.

### 2.6 Custom extension tools

Extensions register tools whose *output also needs rendering* — the screenshot's
`Added read_results to parallel_agents_control` is a custom tool card, not a built-in. Confirmed
registered in the current config:

`parallel_agents`, `parallel_agents_control`, `background_terminal`, `background_terminal_control`,
`todo_web`, `remember`, `ask_user_questions`, `brave_llm_search`, `exa_web_search`, plus
context7-search, openrouter-images and pi-cursor-sdk tools.

All of them render through the same generic tool card (header + ANSI body). No per-extension
renderers — add one only when a specific tool's output actually looks bad.

### 2.7 Extension UIs are already covered by the dialog protocol

Checked what `/memories`, `/todo` and `/parallel-agents` actually call:

| Extension | `ui.*` calls used |
|---|---|
| `memories.ts` | 12 `notify`, 3 `setWidget`, 2 `confirm`, 2 `select`, 1 `editor` |
| `todo.ts` | 3 `notify`, 1 `select`, 1 `input`, 1 `confirm` |
| `parallel-agents.ts` | 8 `notify`, 7 `select`, 6 `input`, 5 `setWidget`, 4 `setStatus` |

**Every one of these is RPC-supported.** These extensions are 100% dialogs, widgets and status
strings — nothing else. So `DialogHost` + `WidgetStack` + `StatusChips` + notify toasts make all
three fully functional, and the four custom panels originally planned (parallel-agents, todo,
memories, and their side-panel shell) are deleted. Same for every future extension.

---

## 3. Architecture

Modelled on `gitManager/` (`src/shared/ipc/gitRpc.ts` + `src-tauri/src/git.rs` + `git:rpc`/`git:data`).

```
┌─ renderer ────────────────────────────────────────────────┐
│  PiAgentPane.tsx                                          │
│   ├── Transcript          user / assistant / thinking     │
│   │     └── ToolCard      header + ANSI body, or DiffView │
│   ├── WidgetStack         setWidget, above + below editor │
│   ├── Composer            @files, images, slash palette   │
│   ├── FooterBar           stats, model, thinking, chips   │
│   └── DialogHost          select/confirm/input/editor     │
│         ▲ piAgentStore (zustand)                          │
└─────────┼─────────────────────────────────────────────────┘
          │ invoke("pi:rpc") / listen("pi:event")
┌─────────▼─────────────────────────────────────────────────┐
│  src-tauri/src/pi_agent.rs                                │
│   tokio::process::Command("pi", ["--mode","rpc"])         │
│   stdin  ← command strings, verbatim                      │
│   stdout → BufReader::lines() → emit each line verbatim   │
│   stderr → capped String for error display                │
└───────────────────────────────────────────────────────────┘
```

### 3.1 Rust is a dumb pipe

`pi_agent.rs` does **not** model the protocol. It spawns, writes lines to stdin, reads lines from
stdout, and emits each one to the renderer as an opaque string. No serde types for 30 commands and
30 event variants — those are TypeScript types on the renderer side only, where they're actually
used. This is also the version that survives pi upgrades: new commands and events need no Rust change.

Why not the PTY layer: RPC is plain pipes, and `src-tauri/src/terminal.rs` would add a PTY, line
discipline and cursor semantics for no benefit. `BufReader::lines()` is also protocol-correct — it
splits on `\n` only, exactly what `rpc.md` requires. (The docs warn Node's `readline` is
non-compliant because it also splits on U+2028/U+2029, legal inside JSON strings. Avoid it in any
Node-side tooling.)

### 3.1b The child outlives the pane component

Only the active view is mounted, so a tab switch unmounts the pane. The pi child is therefore
killed only from `piAgentTabType.closePane`, never on unmount; `piPaneCache.ts` keeps the last
rendered state, draft and attachments, and a remount reattaches (`spawnedPanes`) and resyncs with
the `get_state`/`get_messages`/`get_session_stats` handshake to pick up anything streamed while
hidden.

Keyboard paste in the composer arrives as the `swath:terminal-paste` window event, not as a DOM
paste event: `src-tauri/src/menu.rs` binds Cmd/Ctrl+V to a custom menu item, so the webview never
sees the shortcut. Attachments mirror the `clipboard-image-paste` extension's `[Image N]`
placeholder contract, which is inert under `--mode rpc`.

### 3.2 No validators

`gitRpc.ts` hand-validates because it builds shell-executed git commands from renderer input — a
real trust boundary. Here the renderer sends JSON to pi, which validates it and returns
`{"success": false, "error": ...}`. Types only, no `parsePiRpcRequest`.

### 3.3 Swath integration extensions — do not write OSC to stdout

`integrations/pi/show-image.ts` is the existing pattern for adding functionality: a pi extension
living in this repo that registers a tool (`show_image`) and a command (`/preview`), then signals
Swath by writing OSC 777 (`\x1b]777;swath-image=<base64>`) to stdout, which `TerminalPane` picks up
via `osc/swathImageOsc.ts`.

**That channel does not exist in this pane.** In RPC mode stdout *is* the JSONL protocol stream —
writing a raw OSC blob into it injects non-JSON bytes between records and corrupts framing.

It needs no fix, because the same extension already carries the data structurally:

```ts
return { content: [...], details: result };   // result = { path, mime, bytes }
```

`tool_execution_end` serializes `result.details` (§2.3), so the pane opens the preview by watching
for `toolName === "show_image"` and reading `result.details.path` — no OSC, no extension change.

**The general rule for Swath-integration extensions:** return structured data in `details` and let
the pane react to `tool_execution_end`. Guard any terminal writes with `ctx.mode === "tui"`.
The OSC path stays for when pi runs in a real terminal pane.

### 3.4 Streaming: measure first

`message_update` fires at token rate, which *may* saturate Tauri IPC. It also may not. Ship the
straightforward version: emit every line, replace message content in the store.

If it janks, the fix is ~5 lines renderer-side — buffer deltas in a ref, flush on
`requestAnimationFrame` — not a Rust-side coalescer. Long transcripts get
`content-visibility: auto` in CSS before anyone reaches for a virtualization library.

### 3.5 Division of labour

Swath owns **presentation only**. Everything else is pi's:

| Swath | pi |
|---|---|
| Painting the transcript, cards, diffs, dialogs | Conversation, tools, models, sessions, compaction, retry |
| Formatting numbers pi computed | Computing them (`get_session_stats`) |
| Card timing from event timestamps | Emitting the timestamps |
| `@file` completion UI | Expanding `@path` in the prompt |
| Process lifecycle; pane id used as the session key | All session state (its own session file) |

New agent functionality goes in a **pi extension**, not in Swath — see §3.3. Extensions are also the
supported way to reach back into Swath.

---

## 4. Files

### Rust

| File | Purpose |
|---|---|
| `src-tauri/src/pi_agent.rs` | Spawn/kill per pane, stdin writer, stdout line reader, stderr capture. One file. |

Wire into `lib.rs` (state) and `commands.rs` (`pi_rpc`).

### Shared

`src/shared/ipc/piRpc.ts` — TypeScript types for commands and events. Types only.

Modify: `channels.ts` (`piRpc: "pi:rpc"`, `piEvent: "pi:event"`), `types/tabTypes.ts` (add
`"piAgent"` to `paneKinds`). `PaneMetadata` needs **no** new field: the pane id is already stable
and persisted, and doubles as the pi session id via `--session-id` (verified: it accepts an
arbitrary string and creates the session when missing). pi's session file holds everything else.

### Renderer

```
src/renderer/features/tabTypes/piAgent/
  piAgentTabType.ts        registration
  PiAgentPane.tsx          layout + process lifecycle
  piAgentStore.ts          zustand: messages, tools, widgets, status, dialogs, queue
  eventReducer.ts          RPC event → state (pure)
  eventReducer.test.ts     the one runnable check
  Transcript.tsx           messages, thinking blocks, markdown
  ToolCard.tsx             card chrome + ANSI body + expand
  DiffView.tsx             pi-diff editInfo → highlighted diff
  Composer.tsx             input, slash palette, @files, image paste
  Chrome.tsx               FooterBar + WidgetStack + StatusChips
  DialogHost.tsx           select / confirm / input / editor
  SessionTree.tsx          get_tree / fork / clone / switch_session
  index.ts
src/renderer/lib/ansi.tsx  SGR → spans + <AnsiText> (~80 lines)
```

Modify: `registry.ts`, `paneMetadata.ts`, `icons.tsx`, `browserFixture.ts`.

### Dependencies

`marked` (markdown) and `prism-react-renderer` (highlighting) — both approved. ANSI parsing is
hand-written; only SGR is needed, and no existing dep does it.

---

## 5. Implementation order

**1 — Pipe.** `pi_agent.rs` spawn/kill + line I/O, `pi_rpc` command, `piRpc.ts` types, `piAgent`
registered with a pane that dumps raw JSON. Spawn with the **pane's cwd** — it drives AGENTS.md
discovery and project-local `.pi` extensions. Include a bare `DialogHost` here: `project_trust`
fires at startup and blocks in an untrusted directory. *Milestone: live event stream in a tab.*

**2 — Store + reducer.** `piAgentStore` and pure `eventReducer`: message assembly from
`message_start/update/end` deltas, tool lifecycle from `tool_execution_*` (replace-on-update, not
append), `queue_update`, compaction, retry. Test the reducer against captured fixtures.

**3 — Transcript.** `ansi.tsx`, markdown, `ToolCard` reproducing the TUI's border/duration/status
layout with click-to-expand replacing `ctrl+o`. `DiffView` from `result.details.editInfo`. Every
other tool — built-in and extension — uses the generic ANSI body.

**4 — Chrome + dialogs.** `FooterBar` from `get_state` + `get_session_stats`, `WidgetStack`,
`StatusChips`, styled `DialogHost` with the `extension_ui_response` round-trip and timeout handling.
*This is the step that makes memories, todo and parallel-agents work — see §2.7.*

**5 — Composer.** Input, image paste/drag-drop → base64 on `prompt`, `@file` completion, slash
palette from `get_commands`, model + thinking pickers. Sends with
`streamingBehavior: "followUp"` when streaming.

**6 — Sessions.** New/resume/name, picker over `~/.pi/agent/sessions`, `SessionTree` with
`get_tree`/`fork`/`clone`/`switch_session`. History replay via `get_messages`.

Then: crash handling (surface stderr, restart), `isBusy`, `closePane` cleanup.

---

## 6. Cut from the original plan

| Cut | Why |
|---|---|
| `protocol.rs` serde types | Rust forwards opaque lines (§3.1). Survives pi upgrades for free. |
| `parsePiRpcRequest` validators | No trust boundary; pi validates (§3.2). |
| Rust-side delta coalescing | Speculative. rAF batching renderer-side if it janks (§3.3). |
| Transcript virtualization | `content-visibility: auto` first. |
| ParallelAgents / Todo / Memories panels + side-panel shell | Those extensions are pure dialogs + widgets (§2.7). |
| `renderers/extensions/` tier (4 files) | Generic ANSI card covers them. Add one when it looks bad. |
| Separate Bash/Read/Write/MultiEdit renderers | All are "header + monospace body". One component. |
| `piAgentClient.ts` service | One `invoke` call; lives in the store. |
| `theme/piTheme.ts` | Extension content already arrives as truecolor ANSI. App theme for chrome. Parse pi's theme only if it visibly clashes. |
| `export_html` feature work | pi already has the `export_html` command; wire the button, don't build an exporter. |
| Steering UI | Not wanted. `followUp` only. |
| `get_entries` timing replay | Live timing comes from event timestamps. Replayed-history chrome is a nicety. |
| All `pi*` pane metadata, including `piSessionId` | pi's session file persists these; `--session-id <paneId>` reattaches without storing anything. |

Files: 24 → 13. Rust files: 2 → 1.

---

## 7. Risks

| Risk | Mitigation |
|---|---|
| Tool card fidelity drifts from the TUI | `tool-cards.ts` is the reference implementation; port its layout rather than eyeballing the screenshot. |
| Streaming throughput | Measure, then §3.3. |
| pi version drift | Rust is protocol-agnostic; renderer asserts on `get_state` shape at startup and shows a clear error. |
| `pi` not on PATH | Detect at spawn, actionable empty state. |
| `project_trust` blocks startup | Bare `DialogHost` ships in step 1. |
| Concurrent TUI pi on the same session file | GUI is owner; warn on `session_info_changed`. |

## 8. Open items

- `marked` renders to HTML — needs sanitizing or a token-walk to React. Decide in step 3.
- Whether `pi-fff`'s index is queryable outside pi for `@file` completion, or whether to fall back
  to a plain file walk.

---
## 9. Implementation status

**Complete.** All planned steps are built.

| Step | What landed |
|---|---|
| 1 — Pipe | `src-tauri/src/pi_agent.rs`: spawn/send/kill/stderr + a bounded file walk for `@` completion, one thread per stream, stdout lines forwarded verbatim. `pi_rpc` command, `pi:rpc`/`pi:event` channels, `piRpc.ts` types, `piAgent` registered in `paneKinds`, registry, `paneMetadata` and `ViewTabBar`. `std::process` + threads; no tokio. |
| 2 — Store + reducer | `eventReducer.ts` (pure, no module-level mutable state) and `usePiAgent.ts` (`useReducer`). Validated against a real captured turn. |
| 2b — Session reattach | Spawns with `--session-id <paneId>` and hydrates from `get_messages`; history rebuilds tool cards from `toolCall` blocks + `toolResult` messages, since `tool_execution_*` is not replayed. |
| 3 — Transcript | `lib/ansi.tsx` SGR parser, `lib/markdown.tsx` (marked tokens → React, no `dangerouslySetInnerHTML`), `prism-react-renderer` highlighting, tool cards with click-to-expand, collapsible thinking, streaming cursor. |
| 4 — Diffs | `DiffView.tsx` handles both real payload shapes: structured `pi-diff` `editInfo` and baseline `patch`. |
| 5 — Chrome + dialogs | `DialogHost` (select/confirm/input/editor), widget stacks above and below the composer, status chips, and a footer with token/cost/context stats plus model and thinking pickers. |
| 6 — Composer | Image paste and drag-drop, `@file` completion, `/command` palette from `get_commands`, Enter to send, follow-up queueing while streaming. |
| 7 — Sessions | New, rename, compact, and a `SessionTree` panel from `get_tree` with fork. |
| 8 — `show_image` | The pane watches `tool_execution_end` for `show_image` and opens an `imagePreview` pane from `result.details.path` (§3.3). |

Checks: `tsc --noEmit` clean, `eslint --max-warnings=0` clean, **87 tests**, `vite build` and
`cargo check` clean.

### Verification performed

Protocol behaviour was captured from live `pi --mode rpc` runs rather than inferred, and the
captures are committed as test fixtures. The renderer was driven in Chrome against the Vite dev
server: the pane mounts, appears in the tab-type picker, and renders its toolbar, transcript,
composer and footer with no console errors.

**Not verified: a real turn inside the packaged desktop app.** This session had no display access
(`screencapture` fails, and `tauri dev` exits immediately), so the pane has never been exercised
against a live pi process through the Tauri IPC boundary. Specifically unproven end-to-end:
streaming throughput (§3.4), `project_trust` dialogs, and extension widget rendering.
Run `npm run dev` locally and open a Pi Agent tab to close this gap.

### Corrections made during implementation

- The reducer originally accumulated `message_update` deltas from a guessed
  `delta: { text, thinking }` field that does not exist. A real capture showed whole-message
  replacement semantics (§2.4); `fixtures/turn.jsonl` now guards it.
- A `piSessionId` field was added to `PaneMetadata` and then removed: nothing wrote or read it, and
  `--session-id <paneId>` reattaches without persisting anything new.
- `upsertImagePreviewFromTerminal` was renamed to `upsertImagePreviewFromPane`; it was already
  source-pane agnostic and now has two callers.
