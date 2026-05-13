export type SplitDirection = "horizontal" | "vertical";

export type LayoutNode = PaneNode | SplitNode;

export type TabHealth = "healthy" | "warning" | "idle";

export interface PaneEnvVar {
  name: string;
  value: string;
}

export interface PaneMetadata {
  title?: string;
  cwd?: string;
  shellProfileId?: string;
  shellProfile?: ShellProfile | null;
  env?: Record<string, string> | PaneEnvVar[];
  sessionId?: string;
}

export interface PaneNode {
  type: "pane";
  id: string;
  /** Shown in the pane header (e.g. user@host: path). */
  promptLabel?: string;
  /** Optional ANSI text written once after the PTY opens (demo / onboarding). */
  demoBanner?: string;
  title?: string;
  cwd?: string;
  shellProfile?: ShellProfile | null;
  env?: Record<string, string>;
  metadata?: any;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export interface TerminalTab {
  id: string;
  title: string;
  layout: LayoutNode;
  activePaneId: string;
  /** Tab strip status indicator (defaults to healthy when omitted). */
  health?: TabHealth;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  tabs: TerminalTab[];
  activeTabId: string;
  createdAt: number;
  updatedAt: number;
}

export interface ShellProfile {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface AppSettings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  defaultShellProfileId: string;
  shellProfiles: ShellProfile[];
  globalEnv: Record<string, string>;
  confirmBeforeClosingPane: boolean;
}

export interface AppConfig {
  version: 1;
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  settings: AppSettings;
}

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

export interface FolderSelectResult {
  canceled: boolean;
  path: string | null;
  name: string | null;
}

export interface TerminalClipboardPayload {
  text: string;
  imagePath: string | null;
}

export interface TerminalPastePermissionStatus {
  accessibility: "granted" | "prompted" | "unavailable";
}
