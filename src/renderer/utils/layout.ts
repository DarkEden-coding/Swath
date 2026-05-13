import type { LayoutNode, PaneNode, SplitDirection, SplitNode } from "../../main/sharedTypes";
import { createId } from "./ids";

export function createPaneNode(id = createId("pane"), meta: Partial<Omit<PaneNode, "type" | "id">> = {}): PaneNode {
  return { type: "pane", id, ...meta };
}

export function collectPaneIds(node: LayoutNode): string[] {
  if (node.type === "pane") return [node.id];
  return [...collectPaneIds(node.first), ...collectPaneIds(node.second)];
}

export function findPane(node: LayoutNode, paneId: string): PaneNode | null {
  if (node.type === "pane") return node.id === paneId ? node : null;
  return findPane(node.first, paneId) ?? findPane(node.second, paneId);
}

export function splitPane(node: LayoutNode, paneId: string, direction: SplitDirection): LayoutNode {
  return splitPaneWithId(node, paneId, direction, createId("pane"));
}

export function splitPaneWithId(
  node: LayoutNode,
  paneId: string,
  direction: SplitDirection,
  newPaneId: string
): LayoutNode {
  if (node.type === "pane") {
    if (node.id !== paneId) return node;

    const newPane = createPaneNode(newPaneId, {
      cwd: node.cwd,
      shellProfile: node.shellProfile,
      env: node.env ? { ...node.env } : undefined,
      ...(node.metadata ? { metadata: { ...node.metadata, env: cloneEnv(node.metadata.env) } } : {})
    });
    return {
      type: "split",
      id: createId("split"),
      direction,
      ratio: 0.5,
      first: node,
      second: newPane
    } satisfies SplitNode;
  }

  return {
    ...node,
    first: splitPaneWithId(node.first, paneId, direction, newPaneId),
    second: splitPaneWithId(node.second, paneId, direction, newPaneId)
  };
}

export function closePane(node: LayoutNode, paneId: string): LayoutNode {
  const result = closePaneInternal(node, paneId);
  return result.node ?? node;
}

function cloneEnv(env: PaneNode["metadata"] extends infer M ? M extends { env?: infer E } ? E : never : never) {
  return Array.isArray(env) ? env.map((item) => ({ ...item })) : env ? { ...env } : undefined;
}

function closePaneInternal(node: LayoutNode, paneId: string): { node: LayoutNode | null; removed: boolean } {
  if (node.type === "pane") {
    return node.id === paneId ? { node: null, removed: true } : { node, removed: false };
  }

  const first = closePaneInternal(node.first, paneId);
  if (first.removed) {
    if (first.node === null) {
      return { node: node.second, removed: true };
    }
    return { node: { ...node, first: first.node }, removed: true };
  }

  const second = closePaneInternal(node.second, paneId);
  if (second.removed) {
    if (second.node === null) {
      return { node: node.first, removed: true };
    }
    return { node: { ...node, second: second.node }, removed: true };
  }

  return { node, removed: false };
}

export function updateSplitRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.type === "pane") return node;

  if (node.id === splitId) {
    return {
      ...node,
      ratio: Math.min(0.85, Math.max(0.15, ratio))
    };
  }

  return {
    ...node,
    first: updateSplitRatio(node.first, splitId, ratio),
    second: updateSplitRatio(node.second, splitId, ratio)
  };
}
