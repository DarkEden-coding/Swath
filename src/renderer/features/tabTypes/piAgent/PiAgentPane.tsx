/**
 * Native UI for the pi coding agent, driving a `pi --mode rpc` child process.
 *
 * Swath owns presentation only: pi keeps the conversation, tools, models, sessions and stats.
 * See `docs/features/pi-agent-pane.md`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PiCommand } from "../../../../shared/ipc/piRpc";
import * as appActions from "../../../app/appActions";
import { findPane } from "../../../domain/layout/layoutTree";
import { AnsiText } from "../../../lib/ansi";
import { useUiStore } from "../../../state/uiStore";
import { useConfigStore } from "../../../state/configStore";
import { groupPathsFor } from "../../../domain/workspaces/groupActions";
import { PiRootsProvider } from "./PiRootsContext";
import { PaneFrame } from "../../panes/components/PaneFrame";
import type { PaneComponentProps } from "../../panes/paneTypes";
import { Chrome, isEmptyCounterChip } from "./Chrome";
import { Composer } from "./Composer";
import { DialogHost } from "./DialogHost";
import { SessionList, sessionDirOf } from "./SessionList";
import { SessionTree } from "./SessionTree";
import {
  loadScopedModelKeys,
  modelKey,
  saveScopedModelKeys,
  scopedModelsChangeEvent,
  ScopedModelSelector,
} from "./ScopedModelSelector";
import { piPaneCache, type AttachedImage } from "./piPaneCache";
import { Transcript } from "./Transcript";
import { usePiAgent } from "./usePiAgent";
import type { PiNotice } from "./eventReducer";

const BOTTOM_TOLERANCE_PX = 2;
const USER_SCROLL_INTENT_MS = 250;

/** Resolves follow mode without mistaking a programmatic scroll event for user intent. */
export function followStateAfterScroll(
  currentlyFollowing: boolean,
  userInitiated: boolean,
  bottomDistance: number,
): boolean {
  if (bottomDistance <= BOTTOM_TOLERANCE_PX) return true;
  return userInitiated ? false : currentlyFollowing;
}

function NoticeRow({ notice, onDismiss }: { notice: PiNotice; onDismiss: (id: string) => void }) {
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const timer = window.setTimeout(() => dismissRef.current(notice.id), 5_000);
    return () => window.clearTimeout(timer);
  }, [notice.id]);

  return (
    <button
      type="button"
      className={`block w-full px-3 py-1 text-left font-mono text-[11px] ${
        notice.level === "error"
          ? "text-[var(--pi-red)]"
          : notice.level === "warning"
            ? "text-[var(--pi-yellow)]"
            : "text-[var(--pi-muted)]"
      }`}
      onClick={() => onDismiss(notice.id)}
    >
      {notice.message}
    </button>
  );
}

export function PiAgentPane({ workspace, view, pane }: PaneComponentProps): JSX.Element {
  const activePaneId = useUiStore((state) => state.activePaneId);
  const paneId = pane.id;
  const paneMeta = findPane(view.layout, paneId);
  const cwd = (paneMeta?.cwd ?? paneMeta?.metadata?.cwd ?? workspace.path).trim() || workspace.path;
  const isActive = activePaneId === paneId || view.activePaneId === paneId;

  // On a group's shared surface the agent gets every folder in the group; a project pane stays
  // scoped to its own folder.
  const workspaces = useConfigStore((state) => state.config?.workspaces);
  const groupPaths = useMemo(
    () => (workspaces ? groupPathsFor({ workspaces }, workspace.id) : []),
    [workspaces, workspace.id],
  );

  const agent = usePiAgent(paneId, cwd, groupPaths, paneMeta?.metadata?.piSessionFile);
  const { state } = agent;
  const sessionFile = state.state?.sessionFile;
  useEffect(() => {
    if (sessionFile && sessionFile !== paneMeta?.metadata?.piSessionFile) {
      appActions.setPanePiSessionFile(workspace.id, view.id, paneId, sessionFile);
    }
  }, [paneId, paneMeta?.metadata?.piSessionFile, sessionFile, view.id, workspace.id]);

  // Draft and attachments are cached alongside the transcript so a tab switch does not lose them.
  const [draft, setDraft] = useState(() => piPaneCache.get(paneId)?.draft ?? "");
  const [images, setImages] = useState<AttachedImage[]>(
    () => piPaneCache.get(paneId)?.images ?? [],
  );
  useEffect(() => {
    const entry = piPaneCache.get(paneId);
    if (entry) piPaneCache.set(paneId, { ...entry, draft, images });
  }, [paneId, draft, images]);
  const [appliedEditorText, setAppliedEditorText] = useState<string | undefined>(undefined);
  const [treeOpen, setTreeOpen] = useState(false);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [scopedModelsOpen, setScopedModelsOpen] = useState(false);
  const [scopedModelKeys, setScopedModelKeys] = useState<string[] | null>(loadScopedModelKeys);
  const [isFollowing, setIsFollowing] = useState(true);
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrollContentRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const scrollFrameRef = useRef(0);
  const userScrollIntentRef = useRef(false);
  const pointerScrollIntentRef = useRef(false);
  const userScrollTimerRef = useRef<number | undefined>(undefined);

  /** Updates the rendered follow state and the synchronous value used by observers. */
  const updateFollowing = useCallback((following: boolean): void => {
    followingRef.current = following;
    setIsFollowing(following);
  }, []);

  /** Clears any pending user-scroll classification before an explicit bottom request. */
  const clearUserScrollIntent = useCallback((): void => {
    userScrollIntentRef.current = false;
    if (userScrollTimerRef.current !== undefined) {
      window.clearTimeout(userScrollTimerRef.current);
      userScrollTimerRef.current = undefined;
    }
  }, []);

  /** Marks the short window in which a scroll event can represent a user gesture. */
  const markUserScrollIntent = useCallback((): void => {
    clearUserScrollIntent();
    userScrollIntentRef.current = true;
    userScrollTimerRef.current = window.setTimeout(() => {
      userScrollIntentRef.current = false;
      userScrollTimerRef.current = undefined;
    }, USER_SCROLL_INTENT_MS);
  }, [clearUserScrollIntent]);

  /** Coalesces all automatic following into one write using the latest layout. */
  const scheduleScrollToBottom = useCallback((): void => {
    if (!followingRef.current || scrollFrameRef.current) return;
    scrollFrameRef.current = window.requestAnimationFrame(() => {
      scrollFrameRef.current = 0;
      if (!followingRef.current) return;
      const node = scrollRef.current;
      if (node) node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight);
    });
  }, []);

  /** Enables follow mode and aligns the transcript after the current layout settles. */
  const pinToBottom = useCallback((): void => {
    pointerScrollIntentRef.current = false;
    clearUserScrollIntent();
    updateFollowing(true);
    scheduleScrollToBottom();
  }, [clearUserScrollIntent, scheduleScrollToBottom, updateFollowing]);

  const scopedModels = useMemo(
    () =>
      scopedModelKeys === null
        ? state.models
        : state.models.filter((model) => scopedModelKeys.includes(modelKey(model))),
    [scopedModelKeys, state.models],
  );

  useEffect(() => {
    const updateScope = (event: Event): void => {
      setScopedModelKeys((event as CustomEvent<string[]>).detail);
    };
    window.addEventListener(scopedModelsChangeEvent, updateScope);
    return () => window.removeEventListener(scopedModelsChangeEvent, updateScope);
  }, []);

  /** Cycles through Swath's selected models without changing pi's own configured scope. */
  const cycleScopedModel = useCallback((): void => {
    if (scopedModels.length < 2) return;
    const current = state.state?.model ? modelKey(state.state.model) : "";
    const index = scopedModels.findIndex((model) => modelKey(model) === current);
    agent.setModel(modelKey(scopedModels[(index + 1) % scopedModels.length]));
  }, [agent, scopedModels, state.state]);

  const commands = useMemo<PiCommand[]>(
    () => [
      { name: "new", description: "Start a new chat", source: "builtin" },
      { name: "rename", description: "Rename this chat", source: "builtin" },
      { name: "compact", description: "Compact conversation context", source: "builtin" },
      { name: "reload", description: "Reload pi extensions and resources", source: "builtin" },
      { name: "model", description: "Cycle to the next model", source: "builtin" },
      { name: "thinking", description: "Cycle reasoning level", source: "builtin" },
      { name: "tree", description: "Toggle the session tree", source: "builtin" },
      { name: "resume", description: "Resume a previous chat", source: "builtin" },
      {
        name: "scoped-models",
        description: "Choose models shown and cycled by Swath",
        source: "builtin",
      },
      ...state.commands.filter(
        (command) =>
          ![
            "new",
            "rename",
            "compact",
            "reload",
            "model",
            "thinking",
            "tree",
            "resume",
            "scoped-models",
          ].includes(command.name),
      ),
    ],
    [state.commands],
  );

  /** Runs commands provided by this native RPC UI rather than pi extensions. */
  const runUiCommand = (message: string): boolean => {
    const [command, ...args] = message.trim().split(/\s+/);
    if (command === "/new") agent.newSession();
    else if (command === "/compact") agent.compact();
    // Pi's built-in `/reload` is TUI-only; restarting its RPC child reloads the same resources.
    else if (command === "/reload") agent.restart();
    else if (command === "/model") cycleScopedModel();
    else if (command === "/thinking") agent.cycleThinking();
    else if (command === "/tree") {
      if (!treeOpen) agent.refreshTree();
      setTreeOpen(!treeOpen);
    } else if (command === "/resume") {
      setResumeOpen(true);
    } else if (command === "/scoped-models") {
      setScopedModelsOpen(true);
    } else if (command === "/rename") {
      const name = args.join(" ") || prompt("Session name", state.state?.sessionName ?? "");
      if (name) agent.setSessionName(name);
    } else return false;
    return true;
  };

  // pi can prefill the composer via `set_editor_text`. Adjusted during render rather than in an
  // effect, per the "adjusting state when a prop changes" pattern.
  if (state.editorText !== undefined && state.editorText !== appliedEditorText) {
    setAppliedEditorText(state.editorText);
    setDraft(state.editorText);
  }

  useEffect(() => {
    const finishPointerScroll = (): void => {
      if (!pointerScrollIntentRef.current) return;
      pointerScrollIntentRef.current = false;
      markUserScrollIntent();
    };
    window.addEventListener("pointerup", finishPointerScroll);
    window.addEventListener("pointercancel", finishPointerScroll);
    return () => {
      window.removeEventListener("pointerup", finishPointerScroll);
      window.removeEventListener("pointercancel", finishPointerScroll);
    };
  }, [markUserScrollIntent]);

  // Entry and composer updates share the same coalesced writer. Programmatic scroll events cannot
  // disable following because only a recent user input gesture may do that.
  useEffect(() => {
    scheduleScrollToBottom();
  }, [draft, state.entries, scheduleScrollToBottom]);

  // Catch wrapping, asynchronous previews, and pane resizing that do not replace the entries array.
  useEffect(() => {
    const node = scrollRef.current;
    const content = scrollContentRef.current;
    if (!node || !content) return;

    const observer = new ResizeObserver(scheduleScrollToBottom);
    observer.observe(node);
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (scrollFrameRef.current) {
        window.cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = 0;
      }
      clearUserScrollIntent();
    };
  }, [clearUserScrollIntent, scheduleScrollToBottom]);

  const widgetsAbove = Object.values(state.widgets).filter((w) => w.placement === "aboveEditor");
  const widgetsBelow = Object.values(state.widgets).filter((w) => w.placement === "belowEditor");

  // Counter widgets ("background terminals: 0") are noise while at zero, exactly as the footer
  // chips are; a widget whose every line is an empty counter is dropped entirely.
  const renderWidgets = (widgets: typeof widgetsAbove): JSX.Element[] =>
    widgets
      .map((widget) => ({ ...widget, lines: widget.lines.filter((l) => !isEmptyCounterChip(l)) }))
      .filter((widget) => widget.lines.length > 0)
      .map((widget) => (
        <div key={widget.key} className="pi-agent-widget shrink-0 border-t">
          {widget.lines.map((line, index) => (
            <div key={index}>
              <AnsiText text={line} />
            </div>
          ))}
        </div>
      ));

  return (
    <PiRootsProvider cwd={cwd} groupPaths={groupPaths}>
      <PaneFrame
        active={isActive}
        title={state.title ?? state.state?.sessionName ?? "pi"}
        statusClass={state.exited ? "exited" : state.isStreaming ? "running" : "dormant"}
        onActivate={() => appActions.setActivePane(workspace.id, view.id, paneId)}
        onSplitRight={(kind) =>
          appActions.splitPane(workspace.id, view.id, paneId, "vertical", kind)
        }
        onSplitDown={(kind) =>
          appActions.splitPane(workspace.id, view.id, paneId, "horizontal", kind)
        }
        onClose={() => appActions.closePane(workspace.id, view.id, paneId)}
      >
        <div className="pi-agent relative flex h-full min-h-0 overflow-hidden">
          <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {state.notices.length > 0 ? (
              <div className="shrink-0 border-b border-[var(--pi-border-muted)]">
                {state.notices.slice(-3).map((notice) => (
                  <NoticeRow key={notice.id} notice={notice} onDismiss={agent.dismissNotice} />
                ))}
              </div>
            ) : null}

            <div className="relative min-h-0 flex-1">
              <div
                ref={scrollRef}
                className="h-full overflow-auto [overflow-anchor:none]"
                tabIndex={0}
                aria-label="Conversation transcript"
                onWheel={markUserScrollIntent}
                onTouchStart={markUserScrollIntent}
                onTouchMove={markUserScrollIntent}
                onPointerDown={(event) => {
                  const node = event.currentTarget;
                  const bounds = node.getBoundingClientRect();
                  const scrollbarWidth = node.offsetWidth - node.clientWidth;
                  if (
                    event.target === node ||
                    (scrollbarWidth > 0 && event.clientX >= bounds.right - scrollbarWidth)
                  ) {
                    clearUserScrollIntent();
                    pointerScrollIntentRef.current = true;
                  }
                }}
                onKeyDown={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (
                    ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(
                      event.key,
                    )
                  ) {
                    markUserScrollIntent();
                  }
                }}
                onScroll={(event) => {
                  const node = event.currentTarget;
                  const next = followStateAfterScroll(
                    followingRef.current,
                    userScrollIntentRef.current || pointerScrollIntentRef.current,
                    node.scrollHeight - node.scrollTop - node.clientHeight,
                  );
                  if (next !== followingRef.current) updateFollowing(next);
                }}
              >
                <div ref={scrollContentRef} className="min-h-full">
                  {state.entries.length === 0 ? (
                    <div className="grid h-full place-items-center px-6 text-center text-sm text-[var(--pi-dim)]">
                      {state.exited
                        ? "pi exited."
                        : state.error
                          ? state.error
                          : state.state
                            ? "Start a new chat with pi."
                            : `Starting pi in ${cwd}…`}
                    </div>
                  ) : (
                    <Transcript
                      entries={state.entries}
                      working={state.isStreaming}
                      operationStatus={state.operationStatus}
                      cwd={cwd}
                      scrollRootRef={scrollRef}
                    />
                  )}
                </div>
              </div>
              <button
                type="button"
                className={`absolute bottom-3 left-1/2 z-10 grid h-8 w-8 -translate-x-1/2 place-items-center rounded-full border border-[#30363d] bg-[#161b22]/95 text-[#8b949e] shadow-[0_4px_14px_rgba(0,0,0,0.4)] backdrop-blur-sm transition-[opacity,transform,background-color,border-color,color] duration-200 ease-out hover:border-[#484f58] hover:bg-[#21262d] hover:text-[#f0f6fc] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2f81f7] ${!isFollowing && isActive ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-2 opacity-0"}`}
                aria-label="Scroll to bottom"
                aria-hidden={isFollowing || !isActive}
                tabIndex={!isFollowing && isActive ? 0 : -1}
                title="Scroll to bottom"
                onMouseDown={(event) => event.preventDefault()}
                onClick={pinToBottom}
              >
                <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4" fill="none">
                  <path
                    d="M3.5 6 8 10.5 12.5 6"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            </div>

            {renderWidgets(widgetsAbove)}

            <Composer
              paneId={paneId}
              cwd={cwd}
              commands={commands}
              streaming={state.isStreaming}
              thinkingLevel={state.state?.thinkingLevel}
              value={draft}
              images={images}
              onChange={setDraft}
              onImagesChange={setImages}
              onSubmit={(message, images) => {
                pinToBottom();
                if (!images.length && runUiCommand(message)) {
                  setDraft("");
                  return;
                }
                agent.prompt(message, images);
                setDraft("");
              }}
              onCycleModel={cycleScopedModel}
              onCycleThinking={agent.cycleThinking}
            />

            {renderWidgets(widgetsBelow)}

            <Chrome
              cwd={cwd}
              groupPaths={groupPaths}
              status={state.status}
              stats={state.stats}
              model={state.state?.model}
              models={scopedModels}
              thinkingLevel={state.state?.thinkingLevel}
              thinkingLevels={state.thinkingLevels}
              streaming={state.isStreaming}
              compacting={state.isCompacting}
              pendingCount={state.pendingCount}
              exited={state.exited}
              onSetModel={agent.setModel}
              onSetThinking={agent.setThinking}
              onAbort={agent.abort}
              onRestart={agent.restart}
            />
          </div>

          {scopedModelsOpen ? (
            <ScopedModelSelector
              models={state.models}
              selectedKeys={scopedModelKeys ?? state.models.map(modelKey)}
              onSave={(keys) => {
                saveScopedModelKeys(keys);
                setScopedModelKeys(keys);
                setScopedModelsOpen(false);
              }}
              onClose={() => setScopedModelsOpen(false)}
            />
          ) : null}

          {resumeOpen ? (
            <SessionList
              paneId={paneId}
              sessionDir={sessionDirOf(state.state?.sessionFile ?? state.stats?.sessionFile)}
              currentFile={state.state?.sessionFile ?? state.stats?.sessionFile}
              onPick={(sessionPath) => {
                agent.switchSession(sessionPath);
                setResumeOpen(false);
              }}
              onClose={() => setResumeOpen(false)}
            />
          ) : null}

          {treeOpen ? (
            <SessionTree
              tree={state.tree}
              leafId={state.treeLeafId}
              onFork={agent.fork}
              onClose={() => setTreeOpen(false)}
            />
          ) : null}

          <DialogHost
            key={state.dialogs[0]?.id ?? "none"}
            dialog={state.dialogs[0]}
            paneId={paneId}
            cwd={cwd}
            onAnswer={agent.answerDialog}
          />
        </div>
      </PaneFrame>
    </PiRootsProvider>
  );
}
