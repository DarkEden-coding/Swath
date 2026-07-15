import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as appActions from "../../../app/appActions";
import { findPane } from "../../../domain/layout/layoutTree";
import { useUiStore } from "../../../state/uiStore";
import { gitClient, type GitLogEntry, type GitStatusResult } from "../../../services/gitClient";
import { PaneFrame } from "../../panes/components/PaneFrame";
import type { PaneComponentProps } from "../../panes/paneTypes";
import { GitChangesSection, GitHistorySection } from "./GitManagerSections";
import { changePaths, uniqueSortedPaths } from "./gitManagerUtils";
import { useOnClickOutside } from "./useOnClickOutside";
import {
  IconArrowDown,
  IconArrowUp,
  IconCheck,
  IconGitBranch,
  IconMoreVertical,
  IconRefresh,
} from "../../shell/icons";

const COMMIT_MSG_DISPLAY_MAX = 72;

/** Renders source-control operations and repository history for a workspace pane. */
export function GitManagerPane({ workspace, view, pane }: PaneComponentProps): JSX.Element {
  const activePaneId = useUiStore((state) => state.activePaneId);
  const paneId = pane.id;
  const paneMeta = findPane(view.layout, paneId);
  const cwd = (paneMeta?.cwd ?? workspace.path).trim() || workspace.path.trim();
  const headerTitle = paneMeta?.title ?? paneMeta?.metadata?.title ?? "Source Control";

  const isActive = activePaneId === paneId || view.activePaneId === paneId;

  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState("");
  const [commits, setCommits] = useState<GitLogEntry[]>([]);
  const [branches, setBranches] = useState<string[]>([]);
  const [changesOpen, setChangesOpen] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(true);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [fileMenu, setFileMenu] = useState<{ path: string; kind: "staged" | "unstaged" } | null>(
    null,
  );

  const overflowRef = useRef<HTMLDivElement>(null);
  const fileMenuRef = useRef<HTMLDivElement>(null);

  useOnClickOutside(overflowRef, () => setOverflowOpen(false), overflowOpen);
  useOnClickOutside(fileMenuRef, () => setFileMenu(null), fileMenu !== null);

  const refresh = useCallback(
    async (options: { includeLog?: boolean } = {}) => {
      if (!cwd) return;
      const includeLog = options.includeLog ?? true;
      setBusy(true);
      try {
        const [next, logRes] = await Promise.all([
          gitClient.getStatus(cwd),
          includeLog ? gitClient.getLog(cwd) : Promise.resolve(null),
        ]);
        setStatus(next);
        if (logRes) {
          if (logRes.ok) setCommits(logRes.commits);
          else setCommits([]);
        }
        setSelected((prev) => {
          const allowed = new Set(changePaths(next));
          const n = new Set<string>();
          for (const p of prev) {
            if (allowed.has(p)) n.add(p);
          }
          return n;
        });
      } finally {
        setBusy(false);
      }
    },
    [cwd],
  );

  const loadBranches = useCallback(async () => {
    if (!cwd) return;
    const r = await gitClient.listBranches(cwd);
    if (r.ok) setBranches(r.branches);
  }, [cwd]);

  useEffect(() => {
    // Refresh is the external repository synchronization performed when the active path changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const stagedList = useMemo(() => (status?.ok ? uniqueSortedPaths(status.staged) : []), [status]);
  const unstagedList = useMemo(
    () => (status?.ok ? uniqueSortedPaths(status.unstaged) : []),
    [status],
  );
  const changesList = useMemo(() => (status?.ok ? changePaths(status) : []), [status]);

  const togglePath = (path: string): void => {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(path)) n.delete(path);
      else n.add(path);
      return n;
    });
  };

  const toggleAllChanges = (): void => {
    if (!status?.ok) return;
    const all = changePaths(status);
    if (all.length === 0) return;
    const allSelected = all.every((p) => selected.has(p));
    setSelected(allSelected ? new Set() : new Set(all));
  };

  const appendLog = (
    label: string,
    result: { exitCode: number; stdout: string; stderr: string },
  ): void => {
    const parts = [result.stderr, result.stdout].filter((s) => s.trim().length > 0);
    const body = parts.join("\n").trim() || (result.exitCode === 0 ? "Done." : "(no output)");
    setLog(`${label}${result.exitCode !== 0 ? ` (exit ${result.exitCode})` : ""}\n${body}`);
  };

  const runStage = async (paths?: string[]): Promise<void> => {
    const list = paths ?? [...selected];
    if (!cwd || list.length === 0) return;
    setBusy(true);
    try {
      const r = await gitClient.stagePaths(cwd, list);
      appendLog("git add", r);
      if (r.exitCode === 0 && !paths) setSelected(new Set());
      await refresh({ includeLog: false });
    } finally {
      setBusy(false);
    }
  };

  const runUnstage = async (paths: string[]): Promise<void> => {
    if (!cwd || paths.length === 0) return;
    setBusy(true);
    try {
      const r = await gitClient.unstagePaths(cwd, paths);
      appendLog("git restore --staged", r);
      setFileMenu(null);
      await refresh({ includeLog: false });
    } finally {
      setBusy(false);
    }
  };

  const runDiscard = async (paths: string[]): Promise<void> => {
    if (!cwd || paths.length === 0) return;
    if (
      !window.confirm(
        `Discard changes to ${paths.length === 1 ? paths[0] : `${paths.length} files`}? This cannot be undone.`,
      )
    )
      return;
    setBusy(true);
    try {
      const r = await gitClient.discardPaths(cwd, paths);
      appendLog("git restore / git clean", r);
      setFileMenu(null);
      await refresh({ includeLog: false });
    } finally {
      setBusy(false);
    }
  };

  const runCommit = async (): Promise<void> => {
    if (!cwd) return;
    const trimmed = message.trim();
    if (!trimmed) {
      setLog("Commit\nEnter a commit message first.");
      return;
    }
    setBusy(true);
    try {
      const r = await gitClient.commit(cwd, trimmed);
      appendLog("git commit", r);
      if (r.exitCode === 0) setMessage("");
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const runCommitAndSync = async (): Promise<void> => {
    if (!cwd) return;
    const trimmed = message.trim();
    if (!trimmed) {
      setLog("Commit + Sync\nEnter a commit message first.");
      return;
    }
    setBusy(true);
    try {
      const commitResult = await gitClient.commit(cwd, trimmed);
      if (commitResult.exitCode !== 0) {
        appendLog("git commit", commitResult);
        await refresh();
        return;
      }

      setMessage("");
      const syncResult = await gitClient.sync(cwd);
      appendLog("git commit && git pull && git push", {
        exitCode: syncResult.exitCode,
        stdout: [commitResult.stdout, syncResult.stdout]
          .filter((s) => s.trim().length > 0)
          .join("\n"),
        stderr: [commitResult.stderr, syncResult.stderr]
          .filter((s) => s.trim().length > 0)
          .join("\n"),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const runPull = async (): Promise<void> => {
    if (!cwd) return;
    setBusy(true);
    try {
      const r = await gitClient.pull(cwd);
      appendLog("git pull", r);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const runPush = async (): Promise<void> => {
    if (!cwd) return;
    setBusy(true);
    try {
      const r = await gitClient.push(cwd);
      appendLog("git push", r);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const runSync = async (): Promise<void> => {
    if (!cwd) return;
    setBusy(true);
    try {
      const r = await gitClient.sync(cwd);
      appendLog("git pull && git push", r);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const onBranchSelect = async (branch: string): Promise<void> => {
    if (!cwd || !branch) return;
    setBusy(true);
    try {
      const r = await gitClient.checkoutBranch(cwd, branch);
      appendLog(`git switch ${branch}`, r);
      await refresh();
      await loadBranches();
    } finally {
      setBusy(false);
    }
  };

  const copyHash = async (hash: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(hash);
    } catch {
      setLog(`Copy\nUnable to access clipboard.`);
    }
  };

  const repoError =
    status && !status.ok ? (status.error ?? status.stderr ?? "Unable to read repository") : null;
  const branchLine = status?.ok ? (status.branch ?? "(detached)") : repoError ? "—" : "…";

  const btnGhost =
    "inline-flex items-center justify-center gap-1.5 rounded border border-swath-border bg-swath-panel-2 px-2.5 py-1.5 text-[12px] text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border-strong hover:bg-swath-border/30 disabled:opacity-40";

  const iconBtn =
    "grid size-8 shrink-0 place-items-center rounded-md border border-transparent text-swath-muted [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border hover:bg-swath-panel-2 hover:text-swath-text disabled:opacity-40";

  return (
    <PaneFrame
      active={isActive}
      title={headerTitle}
      statusClass={busy ? "running" : "dormant"}
      onActivate={() => appActions.setActivePane(workspace.id, view.id, paneId)}
      onSplitRight={(kind) => appActions.splitPane(workspace.id, view.id, paneId, "vertical", kind)}
      onSplitDown={(kind) =>
        appActions.splitPane(workspace.id, view.id, paneId, "horizontal", kind)
      }
      onClose={() => appActions.closePane(workspace.id, view.id, paneId)}
    >
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-0 bg-swath-bg text-[13px] text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag]">
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-swath-border px-2.5 py-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-swath-muted">
            Source control
          </span>
          <div className="relative" ref={overflowRef}>
            <button
              type="button"
              className={iconBtn}
              title="More actions"
              aria-expanded={overflowOpen}
              aria-haspopup="menu"
              disabled={busy || !cwd}
              onClick={() => setOverflowOpen((o) => !o)}
            >
              <IconMoreVertical width={16} height={16} className="block" />
            </button>
            {overflowOpen ? (
              <div
                className="absolute right-0 top-full z-[80] mt-1 min-w-[160px] rounded-md border border-swath-border bg-swath-panel py-1 shadow-swath-float"
                role="menu"
              >
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full cursor-pointer border-0 bg-transparent px-3 py-2 text-left text-[12px] text-swath-text hover:bg-swath-panel-2"
                  onClick={() => {
                    setOverflowOpen(false);
                    void refresh();
                  }}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="flex w-full cursor-pointer border-0 bg-transparent px-3 py-2 text-left text-[12px] text-swath-text hover:bg-swath-panel-2"
                  onClick={() => {
                    setOverflowOpen(false);
                    void loadBranches();
                  }}
                >
                  Reload branches
                </button>
              </div>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-2 pt-1">
          {!cwd ? (
            <p className="text-swath-muted">
              This workspace has no folder path. Open a folder to use Git.
            </p>
          ) : repoError ? (
            <p className="text-swath-warn">{repoError}</p>
          ) : (
            <>
              <div className="mb-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label
                    className="text-[10px] font-semibold uppercase tracking-wide text-swath-muted"
                    htmlFor={`git-branch-${paneId}`}
                  >
                    Branch
                  </label>
                  <button
                    type="button"
                    className={iconBtn}
                    title="Reload branches"
                    disabled={busy}
                    onClick={() => void loadBranches()}
                  >
                    <IconGitBranch width={16} height={16} className="block" />
                  </button>
                </div>
                <div className="flex gap-1.5">
                  <select
                    id={`git-branch-${paneId}`}
                    className="min-w-0 flex-1 cursor-pointer rounded border border-swath-border bg-swath-panel px-2 py-1.5 font-mono text-[12px] text-swath-text outline-none focus:border-swath-accent"
                    value={branchLine}
                    disabled={busy}
                    onFocus={() => void loadBranches()}
                    onChange={(e) => void onBranchSelect(e.target.value)}
                  >
                    <option value={branchLine}>{branchLine}</option>
                    {branches
                      .filter((b) => b !== branchLine)
                      .map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                  </select>
                </div>
              </div>

              <div className="mb-3">
                <div className="mb-1 flex items-center justify-between gap-2">
                  <label
                    className="text-[10px] font-semibold uppercase tracking-wide text-swath-muted"
                    htmlFor={`git-msg-${paneId}`}
                  >
                    Commit message
                  </label>
                  <span className="font-mono text-[10px] text-swath-muted-2">
                    {message.length} / {COMMIT_MSG_DISPLAY_MAX}
                  </span>
                </div>
                <textarea
                  id={`git-msg-${paneId}`}
                  className="box-border min-h-[72px] w-full resize-y rounded border border-swath-border bg-swath-panel px-2 py-1.5 font-mono text-[12px] text-swath-text outline-none focus:border-swath-accent"
                  placeholder="Enter commit message…"
                  value={message}
                  maxLength={280}
                  disabled={busy}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void runCommit();
                  }}
                />
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded border-0 bg-swath-accent px-2 py-1.5 text-[12px] font-medium text-[#0d1117] [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-swath-accent-strong disabled:opacity-40 sm:flex-none"
                    disabled={busy || stagedList.length === 0}
                    title="Commit staged changes (⌘/Ctrl+Enter)"
                    onClick={() => void runCommit()}
                  >
                    <IconCheck width={15} height={15} className="block" strokeWidth={2.25} />
                    Commit
                  </button>
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={busy || stagedList.length === 0}
                    title="Commit staged changes, then pull and push"
                    onClick={() => void runCommitAndSync()}
                  >
                    <IconRefresh
                      width={14}
                      height={14}
                      className="block shrink-0"
                      strokeWidth={2.25}
                    />
                    Commit + Sync
                  </button>
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={busy || !cwd}
                    title="Pull then push"
                    onClick={() => void runSync()}
                  >
                    <IconRefresh
                      width={14}
                      height={14}
                      className="block shrink-0"
                      strokeWidth={2.25}
                    />
                    Sync
                  </button>
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={busy || !cwd}
                    title="Push"
                    onClick={() => void runPush()}
                  >
                    <IconArrowUp
                      width={14}
                      height={14}
                      className="block shrink-0"
                      strokeWidth={2.25}
                    />
                    Push
                  </button>
                  <button
                    type="button"
                    className={btnGhost}
                    disabled={busy || !cwd}
                    title="Pull"
                    onClick={() => void runPull()}
                  >
                    <IconArrowDown
                      width={14}
                      height={14}
                      className="block shrink-0"
                      strokeWidth={2.25}
                    />
                    Pull
                  </button>
                </div>
                <p className="mt-1 text-[10px] text-swath-muted-2">
                  ⌘/Ctrl+Enter commits when focus is in the message field.
                </p>
              </div>

              <GitChangesSection
                vm={{
                  open: changesOpen,
                  busy,
                  staged: stagedList,
                  unstaged: unstagedList,
                  paths: changesList,
                  selected,
                  fileMenu,
                  fileMenuRef,
                  toggleOpen: () => setChangesOpen((o) => !o),
                  togglePath,
                  toggleAll: toggleAllChanges,
                  setFileMenu,
                  stage: (paths) => void runStage(paths),
                  unstage: (paths) => void runUnstage(paths),
                  discard: (paths) => void runDiscard(paths),
                }}
              />
              <GitHistorySection
                commits={commits}
                open={historyOpen}
                toggleOpen={() => setHistoryOpen((o) => !o)}
                copyHash={(hash) => void copyHash(hash)}
              />
            </>
          )}
        </div>

        {log ? (
          <div className="max-h-[26%] shrink-0 overflow-y-auto border-t border-swath-border bg-swath-panel px-2 py-1.5 font-mono text-[11px] text-swath-muted-2">
            <pre className="m-0 whitespace-pre-wrap break-words">{log}</pre>
          </div>
        ) : null}
      </div>
    </PaneFrame>
  );
}
