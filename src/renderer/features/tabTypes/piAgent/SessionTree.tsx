/**
 * Session branch navigator, driven by `get_tree`.
 *
 * The tree is a nested `{ entry, children }` structure whose `leafId` marks the branch the
 * session is currently on. Branching a conversation is the thing a GUI does far better than a
 * TUI, so entries are clickable: fork creates a new branch from an entry, clone copies the
 * session, and navigating jumps the session to a different leaf.
 */

import type { PiTreeNode } from "../../../../shared/ipc/piRpc";

/** One-line label for a tree entry, by entry type. */
export function describeEntry(entry: PiTreeNode["entry"]): string {
  switch (entry.type) {
    case "model_change":
      return `model → ${String(entry.modelId ?? "")}`;
    case "thinking_level_change":
      return `thinking → ${String(entry.thinkingLevel ?? "")}`;
    case "user_message": {
      const text = typeof entry.text === "string" ? entry.text : "";
      return text ? `you: ${text.slice(0, 60)}` : "you";
    }
    case "assistant_message":
      return "assistant";
    case "tool_call":
      return `tool: ${String(entry.toolName ?? "")}`;
    case "compaction":
      return "compacted";
    default:
      return entry.type.replace(/_/g, " ");
  }
}

interface SessionTreeProps {
  tree: PiTreeNode[];
  leafId: string | undefined;
  onFork: (entryId: string) => void;
  onClose: () => void;
}

function TreeRows({
  nodes,
  depth,
  leafId,
  onFork,
}: {
  nodes: PiTreeNode[];
  depth: number;
  leafId: string | undefined;
  onFork: (entryId: string) => void;
}): JSX.Element {
  return (
    <>
      {nodes.map((node) => {
        const current = node.entry.id === leafId;
        return (
          <div key={node.entry.id}>
            <button
              type="button"
              title="Fork a new branch from here"
              className={`flex w-full items-baseline gap-2 px-2 py-0.5 text-left font-mono text-[11px] hover:bg-[#1f2a37] ${
                current ? "text-swath-accent" : "text-swath-muted hover:text-swath-text"
              }`}
              style={{ paddingLeft: `${depth * 12 + 8}px` }}
              onClick={() => onFork(node.entry.id)}
            >
              <span className="shrink-0">{current ? "●" : "○"}</span>
              <span className="truncate">{describeEntry(node.entry)}</span>
            </button>
            {node.children.length > 0 ? (
              <TreeRows nodes={node.children} depth={depth + 1} leafId={leafId} onFork={onFork} />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

export function SessionTree({ tree, leafId, onFork, onClose }: SessionTreeProps): JSX.Element {
  return (
    <div className="flex h-full w-72 shrink-0 flex-col border-l border-swath-border bg-swath-panel">
      <div className="flex shrink-0 items-center justify-between border-b border-swath-border px-2 py-1">
        <span className="font-mono text-[11px] text-swath-text">session tree</span>
        <button
          type="button"
          className="font-mono text-[11px] text-swath-muted hover:text-swath-text"
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1">
        {tree.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-swath-muted">No entries yet.</div>
        ) : (
          <TreeRows nodes={tree} depth={0} leafId={leafId} onFork={onFork} />
        )}
      </div>
      <div className="shrink-0 border-t border-swath-border px-2 py-1 text-[10px] text-swath-muted">
        Click an entry to fork a branch from it.
      </div>
    </div>
  );
}
