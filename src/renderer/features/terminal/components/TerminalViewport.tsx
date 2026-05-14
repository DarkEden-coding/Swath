import type { RefObject } from "react";

interface TerminalViewportProps {
  hostRef: RefObject<HTMLDivElement | null>;
}

export function TerminalViewport({ hostRef }: TerminalViewportProps): JSX.Element {
  return <div ref={hostRef} className="terminal-host h-full min-h-0 min-w-0 overflow-hidden px-2 pb-1.5 pt-2 [&_.xterm]:h-full" />;
}
