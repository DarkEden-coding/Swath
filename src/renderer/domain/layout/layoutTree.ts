import type {
  LayoutNode,
  PaneKind,
  PaneNode,
  SplitDirection,
  SplitNode,
} from "../../../shared/types";
import { createId } from "../../utils/ids";

type PaneMetadataEnv = NonNullable<PaneNode["metadata"]>["env"];

/** Creates a pane leaf with the supplied kind and metadata. */
export function createPaneLeaf(
  kind: PaneKind = "terminal",
  id = createId("pane"),
  meta: Partial<Omit<PaneNode, "type" | "id">> = {},
): PaneNode {
  const { kind: _ignoredKind, ...rest } = meta;
  return { type: "pane", id, kind, ...rest };
}

/** Creates a pane node with terminal defaults. */
export function createPaneNode(
  id = createId("pane"),
  meta: Partial<Omit<PaneNode, "type" | "id">> = {},
): PaneNode {
  const { kind = "terminal", ...rest } = meta;
  return createPaneLeaf(kind, id, rest);
}

/** Collects pane identifiers from a layout tree. */
export function collectPaneIds(node: LayoutNode): string[] {
  if (node.type === "pane") return [node.id];
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

/** Collects pane nodes from a layout tree. */
export function collectPanes(node: LayoutNode): PaneNode[] {
  if (node.type === "pane") return [node];
  return [...collectPanes(node.first), ...collectPanes(node.second)];
}

/** Finds a pane by identifier in a layout tree. */
export function findPane(node: LayoutNode, paneId: string): PaneNode | null {
  if (node.type === "pane") return node.id === paneId ? node : null;
  return findPane(node.first, paneId) ?? findPane(node.second, paneId);
}

/** Splits a pane and generates an identifier for the new pane. */
export function splitPane(node: LayoutNode, paneId: string, direction: SplitDirection): LayoutNode {
  return splitPaneWithId(node, paneId, direction, createId("pane"));
}

/** Splits a pane using an explicit identifier for the new pane. */
export function splitPaneWithId(
  node: LayoutNode,
  paneId: string,
  direction: SplitDirection,
  newPaneId: string,
  kind?: PaneKind,
  meta?: Partial<Omit<PaneNode, "type" | "id">>,
): LayoutNode {
  if (node.type === "pane") {
    if (node.id !== paneId) return node;

    const newPane = createPaneLeaf(
      kind ?? node.kind,
      newPaneId,
      meta ?? {
        title: node.title,
        promptLabel: node.promptLabel,
        cwd: node.cwd,
        shellProfile: node.shellProfile,
        env: node.env ? { ...node.env } : undefined,
        terminal: node.terminal
          ? { ...node.terminal, env: node.terminal.env ? { ...node.terminal.env } : undefined }
          : undefined,
        ...(node.metadata
          ? { metadata: { ...node.metadata, env: cloneEnv(node.metadata.env) } }
          : {}),
      },
    );
    return {
      type: "split",
      id: createId("split"),
      direction,
      ratio: 0.5,
      first: node,
      second: newPane,
    } satisfies SplitNode;
  }

  return {
    ...node,
    first: splitPaneWithId(node.first, paneId, direction, newPaneId, kind, meta),
    second: splitPaneWithId(node.second, paneId, direction, newPaneId, kind, meta),
  };
}

/** Removes a pane while preserving a valid layout root. */
export function closePane(node: LayoutNode, paneId: string): LayoutNode {
  const result = closePaneInternal(node, paneId);
  return result.node ?? node;
}

/** Clones pane environment metadata. */
function cloneEnv(env: PaneMetadataEnv | undefined): PaneMetadataEnv | undefined {
  return Array.isArray(env) ? env.map((item) => ({ ...item })) : env ? { ...env } : undefined;
}

/** Recursively removes a pane and reports whether it was found. */
function closePaneInternal(
  node: LayoutNode,
  paneId: string,
): { node: LayoutNode | null; removed: boolean } {
  if (node.type === "pane") {
    return node.id === paneId ? { node: null, removed: true } : { node, removed: false };
  }

  const first = closePaneInternal(node.first, paneId);
  if (first.removed) {
    if (first.node === null) return { node: node.second, removed: true };
    return { node: { ...node, first: first.node }, removed: true };
  }

  const second = closePaneInternal(node.second, paneId);
  if (second.removed) {
    if (second.node === null) return { node: node.first, removed: true };
    return { node: { ...node, second: second.node }, removed: true };
  }

  return { node, removed: false };
}

/** Updates and clamps a split ratio in a layout tree. */
export function updateSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === "pane") return node;

  if (node.id === splitId) {
    return { ...node, ratio: Math.min(0.85, Math.max(0.15, ratio)) };
  }

  return {
    ...node,
    first: updateSplitRatio(node.first, splitId, ratio),
    second: updateSplitRatio(node.second, splitId, ratio),
  };
}
