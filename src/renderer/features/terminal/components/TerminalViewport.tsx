import type { RefObject } from "react";

interface TerminalViewportProps {
  hostRef: RefObject<HTMLDivElement | null>;
  suspended?: boolean;
}

export function TerminalViewport({ hostRef, suspended = false }: TerminalViewportProps): JSX.Element {
  return (
    <div
      ref={hostRef}
      className={`terminal-host relative h-full min-h-0 min-w-0 overflow-hidden px-2 pb-1.5 pt-2 [&_.xterm]:h-full ${suspended ? "bg-[#0d1117]" : ""}`}
    >
      {suspended ? (
        <div className="pointer-events-none absolute inset-0 grid place-items-center px-4 text-center text-xs text-swath-muted">
          Select this pane to show the terminal
        </div>
      ) : null}
    </div>
  );
}
