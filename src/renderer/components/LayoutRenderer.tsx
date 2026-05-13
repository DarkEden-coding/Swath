import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import type { AppSettings, LayoutNode, SplitNode, TerminalTab, Workspace } from "../../main/sharedTypes";
import { useAppStore } from "../state/appStore";
import { TerminalPane } from "./TerminalPane";

interface LayoutRendererProps {
  workspace: Workspace;
  tab: TerminalTab;
  settings: AppSettings;
  node: LayoutNode;
}

export function LayoutRenderer({ workspace, tab, settings, node }: LayoutRendererProps): JSX.Element {
  if (node.type === "pane") {
    return <TerminalPane workspace={workspace} tab={tab} paneId={node.id} settings={settings} />;
  }

  return <SplitRenderer workspace={workspace} tab={tab} settings={settings} node={node} />;
}

interface SplitRendererProps {
  workspace: Workspace;
  tab: TerminalTab;
  settings: AppSettings;
  node: SplitNode;
}

function SplitRenderer({ workspace, tab, settings, node }: SplitRendererProps): JSX.Element {
  const setSplitRatio = useAppStore((state) => state.setSplitRatio);
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
      setSplitRatio(workspace.id, tab.id, node.id, position / total);
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
        <LayoutRenderer workspace={workspace} tab={tab} settings={settings} node={node.first} />
      </div>
      <div className={`split-resizer ${vertical ? "vertical" : "horizontal"}`} onPointerDown={beginResize}>
        <span className="split-resizer-grip" aria-hidden />
      </div>
      <div className="split-child" style={{ flexBasis: `${(1 - node.ratio) * 100}%` }}>
        <LayoutRenderer workspace={workspace} tab={tab} settings={settings} node={node.second} />
      </div>
    </div>
  );
}
