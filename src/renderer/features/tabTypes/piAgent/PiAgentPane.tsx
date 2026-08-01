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
import { PaneFrame } from "../../panes/components/PaneFrame";
import type { PaneComponentProps } from "../../panes/paneTypes";
import { Chrome } from "./Chrome";
import { Composer } from "./Composer";
import { DialogHost } from "./DialogHost";
import { SessionTree } from "./SessionTree";
import { Transcript } from "./Transcript";
import { usePiAgent } from "./usePiAgent";

export function PiAgentPane({ workspace, view, pane }: PaneComponentProps): JSX.Element {
  const activePaneId = useUiStore((state) => state.activePaneId);
  const paneId = pane.id;
  const paneMeta = findPane(view.layout, paneId);
  const cwd = (paneMeta?.cwd ?? paneMeta?.metadata?.cwd ?? workspace.path).trim() || workspace.path;
  const isActive = activePaneId === paneId || view.activePaneId === paneId;

  // The `show_image` tool opens a preview pane beside this one.
  const showImage = useCallback(
    (path: string) => {
      appActions.upsertImagePreviewFromPane(workspace.id, view.id, paneId, path);
    },
    [workspace.id, view.id, paneId],
  );

  const agent = usePiAgent(paneId, cwd, showImage);
  const { state } = agent;
  const [draft, setDraft] = useState("");
  const [appliedEditorText, setAppliedEditorText] = useState<string | undefined>(undefined);
  const [treeOpen, setTreeOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const commands = useMemo<PiCommand[]>(
    () => [
      { name: "new", description: "Start a new chat", source: "builtin" },
      { name: "rename", description: "Rename this chat", source: "builtin" },
      { name: "compact", description: "Compact conversation context", source: "builtin" },
      { name: "model", description: "Cycle to the next model", source: "builtin" },
      { name: "thinking", description: "Cycle reasoning level", source: "builtin" },
      ...state.commands.filter(
        (command) => !["new", "rename", "compact", "model", "thinking"].includes(command.name),
      ),
    ],
    [state.commands],
  );

  /** Runs commands provided by this native RPC UI rather than pi extensions. */
  const runUiCommand = (message: string): boolean => {
    const [command, ...args] = message.trim().split(/\s+/);
    if (command === "/new") agent.newSession();
    else if (command === "/compact") agent.compact();
    else if (command === "/model") agent.cycleModel();
    else if (command === "/thinking") agent.cycleThinking();
    else if (command === "/rename") {
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

  // Follow output while the user is at the bottom; stop as soon as they scroll away.
  useEffect(() => {
    const node = scrollRef.current;
    if (node && pinnedRef.current) node.scrollTop = node.scrollHeight;
  }, [state.entries]);

  const widgetsAbove = Object.values(state.widgets).filter((w) => w.placement === "aboveEditor");
  const widgetsBelow = Object.values(state.widgets).filter((w) => w.placement === "belowEditor");

  const renderWidgets = (widgets: typeof widgetsAbove): JSX.Element[] =>
    widgets.map((widget) => (
      <div
        key={widget.key}
        className="shrink-0 border-t border-swath-border px-3 py-1 font-mono text-[11px]"
      >
        {widget.lines.map((line, index) => (
          <div key={index}>
            <AnsiText text={line} />
          </div>
        ))}
      </div>
    ));

  return (
    <PaneFrame
      active={isActive}
      title={state.state?.sessionName ?? "pi"}
      statusClass={state.exited ? "exited" : state.isStreaming ? "running" : "dormant"}
      onActivate={() => appActions.setActivePane(workspace.id, view.id, paneId)}
      onSplitRight={(kind) => appActions.splitPane(workspace.id, view.id, paneId, "vertical", kind)}
      onSplitDown={(kind) =>
        appActions.splitPane(workspace.id, view.id, paneId, "horizontal", kind)
      }
      onClose={() => appActions.closePane(workspace.id, view.id, paneId)}
    >
      <div className="relative flex h-full min-h-0 bg-[#0d1117]">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex shrink-0 items-center gap-2 border-b border-swath-border bg-swath-panel px-2.5 py-1 font-mono text-[11px] text-swath-muted">
            <button
              type="button"
              className="hover:text-swath-text"
              onClick={() => runUiCommand("/new")}
              disabled={state.isStreaming}
            >
              new
            </button>
            <button
              type="button"
              className="hover:text-swath-text"
              onClick={() => runUiCommand("/rename")}
            >
              rename
            </button>
            <button
              type="button"
              className="hover:text-swath-text"
              onClick={() => runUiCommand("/compact")}
              disabled={state.isStreaming || state.isCompacting}
            >
              compact
            </button>
            <button
              type="button"
              className={`ml-auto hover:text-swath-text ${treeOpen ? "text-swath-text" : ""}`}
              onClick={() => {
                if (!treeOpen) agent.refreshTree();
                setTreeOpen((value) => !value);
              }}
            >
              tree
            </button>
          </div>

          {state.notices.length > 0 ? (
            <div className="shrink-0 border-b border-swath-border">
              {state.notices.slice(-3).map((notice) => (
                <button
                  key={notice.id}
                  type="button"
                  className={`block w-full px-3 py-1 text-left font-mono text-[11px] ${
                    notice.level === "error"
                      ? "text-[#f14c4c]"
                      : notice.level === "warning"
                        ? "text-[#e5e510]"
                        : "text-swath-muted"
                  }`}
                  onClick={() => agent.dismissNotice(notice.id)}
                >
                  {notice.message}
                </button>
              ))}
            </div>
          ) : null}

          <div
            ref={scrollRef}
            className="min-h-0 flex-1 overflow-auto"
            onScroll={(event) => {
              const node = event.currentTarget;
              pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
            }}
          >
            {state.entries.length === 0 ? (
              <div className="grid h-full place-items-center px-6 text-center text-sm text-swath-muted">
                {state.exited ? "pi exited." : state.error ? state.error : `Starting pi in ${cwd}…`}
              </div>
            ) : (
              <Transcript entries={state.entries} />
            )}
          </div>

          {renderWidgets(widgetsAbove)}

          <Composer
            paneId={paneId}
            cwd={cwd}
            commands={commands}
            streaming={state.isStreaming}
            value={draft}
            onChange={setDraft}
            onSubmit={(message, images) => {
              if (!images.length && runUiCommand(message)) {
                setDraft("");
                return;
              }
              agent.prompt(message, images);
              setDraft("");
            }}
            onCycleModel={agent.cycleModel}
            onCycleThinking={agent.cycleThinking}
          />

          {renderWidgets(widgetsBelow)}

          <Chrome
            cwd={cwd}
            status={state.status}
            stats={state.stats}
            model={state.state?.model}
            models={state.models}
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
          onAnswer={agent.answerDialog}
        />
      </div>
    </PaneFrame>
  );
}
