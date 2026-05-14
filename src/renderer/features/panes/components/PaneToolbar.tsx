import { IconClose, IconColumns, IconRows } from "../../shell/icons";

interface PaneToolbarProps {
  title: string;
  statusClass: string;
  onSplitRight: (shiftKey?: boolean) => void;
  onSplitDown: (shiftKey?: boolean) => void;
  onClose: () => void;
}

function statusDotClass(statusClass: string): string {
  if (statusClass === "running") return "bg-swath-good shadow-[0_0_10px_rgba(63,185,80,0.45)]";
  if (statusClass === "exited") return "bg-swath-danger";
  return "bg-swath-muted-2";
}

export function PaneToolbar({ title, statusClass, onSplitRight, onSplitDown, onClose }: PaneToolbarProps): JSX.Element {
  return (
    <div className="flex min-w-0 select-none items-center justify-between gap-2 border-b border-swath-border bg-swath-panel px-2.5">
      <div className="flex min-w-0 items-center gap-2 text-[11px] text-swath-muted">
        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(statusClass)}`} />
        <span className="min-w-0 truncate font-mono">{title}</span>
      </div>
      <div className="flex items-center gap-1">
        <button
          type="button"
          className="grid size-[26px] cursor-pointer place-items-center rounded-md border border-transparent bg-transparent text-sm leading-none text-swath-muted [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border hover:bg-swath-bg hover:text-swath-text"
          title="Split right"
          onClick={(event) => onSplitRight(event.shiftKey)}
        >
          <IconColumns width={15} height={15} className="block" />
        </button>
        <button
          type="button"
          className="grid size-[26px] cursor-pointer place-items-center rounded-md border border-transparent bg-transparent text-sm leading-none text-swath-muted [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border hover:bg-swath-bg hover:text-swath-text"
          title="Split down"
          onClick={(event) => onSplitDown(event.shiftKey)}
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
      </div>
    </div>
  );
}
