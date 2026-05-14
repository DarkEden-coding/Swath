import { useEffect, useRef, useState } from "react";
import type { PaneKind, SplitDirection } from "../../../../shared/types";
import { IconClose, IconColumns, IconRows } from "../../shell/icons";
import { getTabTypes } from "../../tabTypes/registry";

interface PaneToolbarProps {
  title: string;
  statusClass: string;
  onSplitRight: (kind?: PaneKind) => void;
  onSplitDown: (kind?: PaneKind) => void;
  onClose: () => void;
}

function statusDotClass(statusClass: string): string {
  if (statusClass === "running") return "bg-swath-good shadow-[0_0_10px_rgba(63,185,80,0.45)]";
  if (statusClass === "exited") return "bg-swath-danger";
  return "bg-swath-muted-2";
}

export function PaneToolbar({ title, statusClass, onSplitRight, onSplitDown, onClose }: PaneToolbarProps): JSX.Element {
  const [splitDirection, setSplitDirection] = useState<SplitDirection | null>(null);
  const selectorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (selectorRef.current && !selectorRef.current.contains(event.target as Node)) {
        setSplitDirection(null);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const split = (direction: SplitDirection, shiftKey: boolean): void => {
    if (shiftKey) {
      setSplitDirection(direction);
      return;
    }
    direction === "vertical" ? onSplitRight() : onSplitDown();
  };

  const selectSplitKind = (kind: PaneKind): void => {
    if (!splitDirection) return;
    splitDirection === "vertical" ? onSplitRight(kind) : onSplitDown(kind);
    setSplitDirection(null);
  };

  return (
    <div className="flex min-w-0 select-none items-center justify-between gap-2 border-b border-swath-border bg-swath-panel px-2.5">
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-swath-muted">
        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(statusClass)}`} />
        <span className="min-w-0 truncate font-mono">{title}</span>
      </div>
      <div className="relative flex items-center gap-1" ref={selectorRef}>
        <button
          type="button"
          className="grid size-[26px] cursor-pointer place-items-center rounded-md border border-transparent bg-transparent text-sm leading-none text-swath-muted [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border hover:bg-swath-bg hover:text-swath-text"
          title="Split right"
          onClick={(event) => split("vertical", event.shiftKey)}
        >
          <IconColumns width={15} height={15} className="block" />
        </button>
        <button
          type="button"
          className="grid size-[26px] cursor-pointer place-items-center rounded-md border border-transparent bg-transparent text-sm leading-none text-swath-muted [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border hover:bg-swath-bg hover:text-swath-text"
          title="Split down"
          onClick={(event) => split("horizontal", event.shiftKey)}
        >
          <IconRows width={15} height={15} className="block" />
        </button>
        <button
          type="button"
          className="grid size-[26px] cursor-pointer place-items-center rounded-md border border-transparent bg-transparent text-sm leading-none text-swath-muted [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border hover:bg-swath-bg hover:text-swath-text"
          title="Close pane"
          onClick={onClose}
        >
          <IconClose width={15} height={15} className="block" />
        </button>
        {splitDirection ? (
          <div className="absolute right-0 top-full z-[100] mt-1 flex min-w-[140px] flex-col gap-0.5 rounded-md border border-swath-border bg-[#1a1a1a] p-1 shadow-swath-float">
            {getTabTypes().map((tabType) => (
              <button
                key={tabType.kind}
                type="button"
                className="flex cursor-pointer items-center gap-2 rounded border-0 bg-transparent px-2.5 py-1.5 text-left text-[13px] text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-[#2a2a2a]"
                onClick={() => selectSplitKind(tabType.kind)}
              >
                <span>{tabType.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
