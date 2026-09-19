# Shared-execution Phase 0 baseline

Recorded before shared-execution behavior changes.

| Check                          | Result                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed Pi                   | `pi --version` reports `0.85.1` (`@earendil-works/pi-coding-agent`)                                                                                         |
| Pi documentation reviewed      | Local `docs/rpc.md` and `docs/session-format.md` reviewed                                                                                                   |
| Existing focused Rust tests    | `pi_agent`, `terminal`, and `remote` test modules compile and pass after running each Cargo filter separately                                               |
| Existing combined Cargo filter | Fails: Cargo accepts one test-name filter, so `cargo test --lib pi_agent::tests terminal::tests remote::tests` is invalid                                   |
| Characterization tests         | Pi spawn replacement, global terminal attachment/streaming, and global bounded connector subscriptions are covered without starting Pi or a network service |
| Formatting                     | `rustfmt --check` passes for the three touched Rust files; workspace-wide `cargo fmt --check` still reports pre-existing formatting in `src/files.rs`       |

## Known baseline behavior

- `PiManager::spawn` calls `kill(pane_id)` before starting a process; another client can destroy the pane's existing Pi.
- Terminal `attach` replays with `replay_to_app`; `set_streaming` stores one flag and adjusts one replay buffer per session.
- Connector events use a single `broadcast::channel(1024)` and every WebSocket subscribes to it. Replay sent through that bus is not viewer-addressed.

## Required follow-up validation

The Pi/headless and OpenRaft conclusions are local development validation, not cross-platform certification. Run the Phase 0 prototype and runtime checks on **macOS, Linux, and Windows** before enabling shared execution.
