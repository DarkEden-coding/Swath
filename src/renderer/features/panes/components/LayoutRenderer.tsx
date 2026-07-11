import { Suspense, useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { AppSettings, LayoutNode, PaneLeaf, SplitNode, Workspace, WorkspaceView } from "../../../../shared/types";
import { setSplitRatio } from "../../../app/appActions";
import { getPaneRegistration } from "../paneRegistry";

interface LayoutRendererProps {
  workspace: Workspace;
  view: WorkspaceView;
  settings: AppSettings;
  node: LayoutNode;
}

export function LayoutRenderer({ workspace, view, settings, node }: LayoutRendererProps): JSX.Element {
  if (node.type === "pane") {
    const pane = node as PaneLeaf;
    const { Component } = getPaneRegistration(pane.kind);
    return (
      <Suspense fallback={<div className="h-full w-full rounded-md border border-swath-border bg-swath-bg" />}>
        <Component key={pane.id} workspace={workspace} view={view} pane={pane} settings={settings} />
      </Suspense>
    );
  }

  return <SplitRenderer workspace={workspace} view={view} settings={settings} node={node} />;
}

interface SplitRendererProps {
  workspace: Workspace;
  view: WorkspaceView;
  settings: AppSettings;
  node: SplitNode;
}

function SplitRenderer({ workspace, view, settings, node }: SplitRendererProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const vertical = node.direction === "vertical";

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const host = hostRef.current;
    if (!host) return;

    event.preventDefault();
    const rect = host.getBoundingClientRect();

    const onMove = (moveEvent: PointerEvent): void => {
      const position = vertical ? moveEvent.clientX - rect.left : moveEvent.clientY - rect.top;
      const total = vertical ? rect.width : rect.height;
      if (total <= 0) return;
      setSplitRatio(workspace.id, view.id, node.id, position / total);
    };

    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };

  const flexDir = vertical ? "flex-row" : "flex-col";

  return (
    <div ref={hostRef} className={`flex h-full w-full min-h-0 min-w-0 ${flexDir}`}>
      <div className="flex min-h-20 min-w-24 overflow-hidden" style={{ flex: `${node.ratio} 1 0` }}>
        <LayoutRenderer workspace={workspace} view={view} settings={settings} node={node.first} />
      </div>
      <div
        className={`group relative z-[2] flex shrink-0 items-center justify-center bg-transparent [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[rgba(56,139,253,0.08)] ${vertical ? "w-2.5 cursor-col-resize" : "h-2.5 cursor-row-resize"}`}
        role="separator"
        tabIndex={0}
        aria-orientation={vertical ? "vertical" : "horizontal"}
        aria-label="Resize panes"
        aria-valuenow={Math.round(node.ratio * 100)}
        onKeyDown={(event) => {
          const decrease = vertical ? event.key === "ArrowLeft" : event.key === "ArrowUp";
          const increase = vertical ? event.key === "ArrowRight" : event.key === "ArrowDown";
          if (!decrease && !increase) return;
          event.preventDefault();
          setSplitRatio(workspace.id, view.id, node.id, node.ratio + (increase ? 0.05 : -0.05));
        }}
        onPointerDown={beginResize}
      >
        <span
          className={`pointer-events-none rounded-full bg-[rgba(56,139,253,0.55)] opacity-0 transition-opacity duration-100 ease-out group-hover:opacity-100 ${vertical ? "h-[18px] w-1" : "h-1 w-[18px]"}`}
          aria-hidden
        />
      </div>
      <div className="flex min-h-20 min-w-24 overflow-hidden" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <LayoutRenderer workspace={workspace} view={view} settings={settings} node={node.second} />
      </div>
    </div>
  );
}
