# Protocol and agent workflow repairs

Initial local installation completed on 2026-10-03 UTC. Changes are published in the Swath and Pi-Config repositories; device credentials, generated dependencies and backups stay untracked.

## Installed changes

- Remote CLIProxy version `8.0.10+costs.4.wsfix.1.reasoning.1`. Existing Costs and WebSocket fixes remain. Chat Completions exports encrypted reasoning and validated replay metadata for coalesced messages, reasoning ordering, and tool linkage. Clients must retain these fields. Native Responses avoids that translation.
- Local Pi 0.99.1 uses native Responses through CLIProxy, preferring WebSockets with stable session identity and connection reuse. One safe reconnect precedes visible SSE fallback. No retry or fallback after partial output. The owned transport extraction resolves the installed Pi runtime on macOS and Linux. Supported versions are Pi 0.99.1 and 1.0.0; review it before adding another version.
- Subagents retain child sessions and parent-child links, inherit trusted preferences, base system instructions and project context, and discover skill metadata without copying unrelated skill bodies or the parent transcript. Approvals, completion, failures and blockers steer the parent at safe boundaries and wake it when idle. The approval policy is unchanged. Interrupted children require explicit `parallel_agents_control` action `resume`, selected `agents`, and a continuation `message`.
- `search` replaces separate local path/content, Brave, Exa and Context7 declarations. Backend options and pagination remain available. Large results retain their full output in readable temporary files.
- Todo mutations return compact deltas. Compaction restores active task state once per checkpoint without waking the model.
- Swath no longer injects `report_progress` or displays its floating window. Historical records remain unchanged and are tolerated.
- Local extension SDK dependencies match Pi 0.99.1. Browser runtime is 0.38.1. Obsolete model guidance and conflicting shell-search rules were removed from fresh prompts.

## Verification

- Swath typecheck, signed macOS build, all 281 unit tests, and lint completed. Lint has nine existing warnings and no errors.
- Nineteen focused extension tests pass, including a real offline Pi SDK scenario for busy/idle supervision, approval waits, overlapping resumes, inherited instructions, and failed resume setup. Search and mocked WebSocket/SSE checks pass. Strict TypeScript checks pass for the changed extensions.
- Remote translator, executor and session packages pass. Targeted reasoning, keepalive-upload and recovery race checks pass three repetitions. The intermittent sessionless upload test had a fake-server close/upload race; its completion now waits for the upload.
- Authenticated model catalog and Responses WebSocket upgrade pass through the private HTTPS gateway. These checks do not prove live upstream generation quality or billed token savings.
- Installed binary matches the built binary. Service is active with no restart loop; configuration and management panel checksums are unchanged.
- `/Applications/Swath.app` has the same stable developer signing team. The current main Swath process was not stopped or restarted.

Fresh Pi sessions load the new extensions. The running Swath process still has its old embedded progress integration until the user relaunches it. Old session transcripts and existing extension runtimes are not rewritten or hot-swapped.

## Backups and rollback

Local backup: `/Users/dark/.pi/backups/protocol-workflow-20261003T013211Z`. It includes the previous app, extension/config snapshots, npm manifest/lock snapshots and verification scripts. Restore selected snapshots only when no session is using the affected runtime; do not overwrite active session files.

Remote backup: `/home/dark/backups/cliproxyapi/protocol-workflow-20261003T013212Z`. The previous binary is `cli-proxy-api.previous`; the new build is `cli-proxy-api.new`. The original Codex credential is privately backed up as `codex-auth.previous.json`. Backups contain secrets and must not be published.

To roll back the remote executable while retaining configuration, credentials and Costs history:

```sh
ssh dark@100.107.192.39 'set -eu
binary=/home/dark/.local/opt/cliproxyapi/cli-proxy-api
backup=/home/dark/backups/cliproxyapi/protocol-workflow-20261003T013212Z
staged=$(mktemp "${binary}.rollback.XXXXXX")
install -m 0755 "$backup/cli-proxy-api.previous" "$staged"
mv -f "$staged" "$binary"
systemctl --user restart cliproxyapi.service'
```

Backend compaction integration and terminal-tool redesign were not changed. Remaining npm dependency/audit warnings were not fixed through unrelated upgrades.
