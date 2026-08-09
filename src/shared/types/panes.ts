import type { ShellProfile } from "./settings";
import type { PaneKind } from "./tabTypes";
export type { PaneKind } from "./tabTypes";

export type SplitDirection = "horizontal" | "vertical";

export interface PaneEnvVar {
  name: string;
  value: string;
}

export interface TerminalPaneConfig {
  cwd?: string;
  shellProfile?: ShellProfile | null;
  env?: Record<string, string>;
  metadata?: PaneMetadata;
}

export interface PaneMetadata {
  title?: string;
  cwd?: string;
  shellProfileId?: string;
  shellProfile?: ShellProfile | null;
  env?: Record<string, string> | PaneEnvVar[];
  sessionId?: string;
  /** Absolute or cwd-relative path for an imagePreview pane (bytes loaded via RPC). */
  imagePath?: string;
  /** Display title for an imagePreview pane (typically the basename). */
  imageTitle?: string;
}

export interface PaneLeaf {
  type: "pane";
  id: string;
  kind: PaneKind;
  title?: string;
  promptLabel?: string;
  demoBanner?: string;
  cwd?: string;
  shellProfile?: ShellProfile | null;
  env?: Record<string, string>;
  terminal?: TerminalPaneConfig;
  metadata?: PaneMetadata;
}

export interface SplitNode {
  type: "split";
  id: string;
  direction: SplitDirection;
  ratio: number;
  first: LayoutNode;
  second: LayoutNode;
}

export type LayoutNode = PaneLeaf | SplitNode;

// Backward-compatible aliases while the renderer is migrated.
export type PaneNode = PaneLeaf;
