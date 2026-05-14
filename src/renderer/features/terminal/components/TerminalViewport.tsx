import type { RefObject } from "react";

interface TerminalViewportProps {
  hostRef: RefObject<HTMLDivElement | null>;
}

export function TerminalViewport({ hostRef }: TerminalViewportProps): JSX.Element {
  return <div ref={hostRef} className="terminal-host" />;
}
