import type { PaneMetadata } from "./panes";
import type { ShellProfile } from "./settings";

export interface TerminalSessionStartRequest {
  sessionId: string;
  cwd: string;
  cols: number;
  rows: number;
  shellProfile?: ShellProfile | null;
  env?: Record<string, string>;
  metadata?: PaneMetadata;
}

export type PtyCreateRequest = TerminalSessionStartRequest;

export interface PtyResizeRequest {
  sessionId: string;
  cols: number;
  rows: number;
}

export interface TerminalSessionAttachRequest extends TerminalSessionStartRequest {
  replay?: boolean;
}

export interface TerminalSessionStatus {
  sessionId: string;
  running: boolean;
}

export interface TerminalSessionExitEvent {
  exitCode: number;
  signal?: number;
}

export interface TerminalClipboardPayload {
  text: string;
  hasImage: boolean;
}

export interface TerminalPastePermissionStatus {
  accessibility: "granted" | "prompted" | "unavailable";
}
