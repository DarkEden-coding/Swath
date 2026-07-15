import { useEffect, useRef } from "react";

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
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);

  const moveFocus = (direction: number): void => {
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
    );
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    buttons[(current + direction + buttons.length) % buttons.length]?.focus();
  };

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Terminal actions"
      className="fixed z-40 min-w-[170px] rounded-lg border border-swath-border bg-[rgba(13,17,23,0.98)] p-1.5 shadow-swath [-webkit-app-region:no-drag] [app-region:no-drag]"
      style={{
        left: Math.max(4, Math.min(x, window.innerWidth - 182)),
        top: Math.max(4, Math.min(y, window.innerHeight - 390)),
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          moveFocus(event.key === "ArrowDown" ? 1 : -1);
        }
      }}
    >
      {terminalContextActions.map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="menuitem"
          className={menuBtn}
          onClick={() => onAction(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
