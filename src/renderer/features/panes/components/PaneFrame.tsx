import type { ReactNode } from "react";
import { PaneToolbar } from "./PaneToolbar";

interface PaneFrameProps {
  active: boolean;
  title: string;
  statusClass?: string;
  onActivate: () => void;
  onSplitRight: (shiftKey?: boolean) => void;
  onSplitDown: (shiftKey?: boolean) => void;
  onClose: () => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  onContextMenu?: React.MouseEventHandler<HTMLDivElement>;
  children: ReactNode;
}

export function PaneFrame({
  active,
  title,
  statusClass = "dormant",
  onActivate,
  onSplitRight,
  onSplitDown,
  onClose,
  onKeyDown,
  onContextMenu,
  children,
}: PaneFrameProps): JSX.Element {
  return (
    <div className={`terminal-pane ${active ? "active" : ""}`} onMouseDown={onActivate} onKeyDown={onKeyDown} onContextMenu={onContextMenu}>
      <PaneToolbar title={title} statusClass={statusClass} onSplitRight={onSplitRight} onSplitDown={onSplitDown} onClose={onClose} />
      {children}
    </div>
  );
}
