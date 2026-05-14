import { useRef, type PointerEvent as ReactPointerEvent } from "react";
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
    return <Component workspace={workspace} view={view} pane={pane} settings={settings} />;
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

  return (
    <div ref={hostRef} className={`split ${vertical ? "split-vertical" : "split-horizontal"}`}>
      <div className="split-child" style={{ flexBasis: `${node.ratio * 100}%` }}>
        <LayoutRenderer workspace={workspace} view={view} settings={settings} node={node.first} />
      </div>
      <div className={`split-resizer ${vertical ? "vertical" : "horizontal"}`} onPointerDown={beginResize}>
        <span className="split-resizer-grip" aria-hidden />
      </div>
      <div className="split-child" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}>
        <LayoutRenderer workspace={workspace} view={view} settings={settings} node={node.second} />
      </div>
    </div>
  );
}
