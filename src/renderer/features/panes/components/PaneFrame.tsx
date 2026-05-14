import type { ReactNode } from "react";
import type { PaneKind } from "../../../../shared/types";
import { PaneToolbar } from "./PaneToolbar";

interface PaneFrameProps {
  active: boolean;
  title: string;
  statusClass?: string;
  onActivate: () => void;
  onSplitRight: (kind?: PaneKind) => void;
  onSplitDown: (kind?: PaneKind) => void;
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
  const ring = active ? "border-[rgba(56,139,253,0.65)] shadow-[0_0_0_1px_rgba(56,139,253,0.12)]" : "border-swath-border";

  return (
    <div
      className={`relative grid h-full w-full min-h-0 min-w-0 grid-rows-[34px_1fr] overflow-hidden rounded-md border bg-swath-bg ${ring}`}
      onMouseDown={onActivate}
      onKeyDown={onKeyDown}
      onContextMenu={onContextMenu}
    >
      <PaneToolbar title={title} statusClass={statusClass} onSplitRight={onSplitRight} onSplitDown={onSplitDown} onClose={onClose} />
      {children}
    </div>
  );
}
