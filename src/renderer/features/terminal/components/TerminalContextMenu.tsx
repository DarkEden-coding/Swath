const terminalContextActions = [
  ["copy", "Copy"],
  ["paste", "Paste"],
  ["selectAll", "Select All"],
  ["clear", "Clear"],
  ["find", "Find"],
  ["restart", "Restart"],
  ["rename", "Rename Pane"],
  ["cwd", "Set Initial CWD"],
  ["splitRight", "Split Right"],
  ["splitDown", "Split Down"],
  ["close", "Close Pane"],
] as const;

const menuBtn =
  "block w-full cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1.5 text-left text-swath-text [-webkit-app-region:no-drag] [app-region:no-drag] hover:border-swath-border hover:bg-[rgba(56,139,253,0.12)]";

interface TerminalContextMenuProps {
  x: number;
  y: number;
  onAction: (action: string) => void;
}

export function TerminalContextMenu({ x, y, onAction }: TerminalContextMenuProps): JSX.Element {
  return (
    <div
      className="fixed z-40 min-w-[170px] rounded-lg border border-swath-border bg-[rgba(13,17,23,0.98)] p-1.5 shadow-swath [-webkit-app-region:no-drag] [app-region:no-drag]"
      style={{ left: x, top: y }}
    >
      {terminalContextActions.map(([id, label]) => (
        <button key={id} type="button" className={menuBtn} onClick={() => onAction(id)}>
          {label}
        </button>
      ))}
    </div>
  );
}
