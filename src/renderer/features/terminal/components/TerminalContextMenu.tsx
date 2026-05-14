const terminalContextActions = [
  ["copy", "Copy"], ["paste", "Paste"], ["selectAll", "Select All"], ["clear", "Clear"], ["find", "Find"],
  ["restart", "Restart"], ["rename", "Rename Pane"], ["cwd", "Set Initial CWD"], ["splitRight", "Split Right"],
  ["splitDown", "Split Down"], ["close", "Close Pane"]
] as const;

interface TerminalContextMenuProps {
  x: number;
  y: number;
  onAction: (action: string) => void;
}

export function TerminalContextMenu({ x, y, onAction }: TerminalContextMenuProps): JSX.Element {
  return (
    <div className="terminal-context-menu" style={{ left: x, top: y }}>
      {terminalContextActions.map(([id, label]) => <button key={id} type="button" onClick={() => onAction(id)}>{label}</button>)}
    </div>
  );
}
