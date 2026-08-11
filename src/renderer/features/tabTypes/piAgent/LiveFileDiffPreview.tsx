import { useEffect, useMemo, useState, type ReactNode } from "react";
import { readTextFile } from "../../../services/filesClient";
import { DiffHeader, StructuredDiffView, type DiffLine, type StructuredDiff } from "./DiffView";

interface Replacement {
  path: string;
  oldText: string;
  newText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** Builds a numbered three-line-context diff when `oldText` can be located exactly. */
export function buildContextualDiff(
  source: string,
  oldText: string,
  newText: string,
  filePath?: string,
): StructuredDiff | null {
  const offset = source.indexOf(oldText);
  if (!oldText || offset < 0) return null;

  const beforeText = source.slice(0, offset);
  const before = beforeText.split("\n");
  if (beforeText.endsWith("\n")) before.pop();
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const after = source.slice(offset + oldText.length).split("\n");
  if (after[0] === "") after.shift();
  const startLine = before.length + 1;
  const contextBefore = before.slice(-3);
  const contextAfter = after.slice(0, 3);
  const firstContextLine = startLine - contextBefore.length;
  const lines: DiffLine[] = [];

  contextBefore.forEach((content, index) =>
    lines.push({
      type: "ctx",
      content,
      oldNum: firstContextLine + index,
      newNum: firstContextLine + index,
    }),
  );
  oldLines.forEach((content, index) =>
    lines.push({ type: "del", content, oldNum: startLine + index, newNum: null }),
  );
  newLines.forEach((content, index) =>
    lines.push({ type: "add", content, oldNum: null, newNum: startLine + index }),
  );
  contextAfter.forEach((content, index) =>
    lines.push({
      type: "ctx",
      content,
      oldNum: startLine + oldLines.length + index,
      newNum: startLine + newLines.length + index,
    }),
  );

  return { filePath, lines, added: newLines.length, removed: oldLines.length };
}

/** Extracts file replacements from the live `edit` and `apply_patch` argument shapes. */
function replacements(toolName: string, args: Record<string, unknown>): Replacement[] {
  if (toolName === "edit") {
    const path = text(args.path);
    const edits = Array.isArray(args.edits) ? args.edits.filter(isRecord) : [args];
    return path
      ? edits.flatMap((edit) => {
          const oldText = text(edit.oldText) ?? text(edit.old_string);
          const newText = text(edit.newText) ?? text(edit.new_string);
          return oldText !== undefined && newText !== undefined ? [{ path, oldText, newText }] : [];
        })
      : [];
  }

  if (toolName !== "apply_patch" || !Array.isArray(args.changes)) return [];
  return args.changes.filter(isRecord).flatMap((change) => {
    const path = text(change.path);
    const oldText = text(change.oldText);
    const newText = text(change.newText);
    return path && oldText !== undefined && newText !== undefined
      ? [{ path, oldText, newText }]
      : [];
  });
}

function relativePath(cwd: string, path: string): string | null {
  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/$/, "");
  const normalizedPath = path.replace(/\\/g, "/");
  if (!normalizedPath.startsWith("/")) return normalizedPath;
  return normalizedPath.startsWith(`${normalizedCwd}/`)
    ? normalizedPath.slice(normalizedCwd.length + 1)
    : null;
}

/** Reads each target file once and turns streaming replacements into real contextual diffs. */
export function LiveFileDiffPreview({
  toolName,
  args,
  cwd,
  fallback,
}: {
  toolName: string;
  args: Record<string, unknown>;
  cwd: string;
  fallback?: ReactNode;
}): JSX.Element | null {
  const changes = useMemo(() => replacements(toolName, args), [toolName, args]);
  const paths = useMemo(() => [...new Set(changes.map((change) => change.path))], [changes]);
  const pathKey = paths.join("\0");
  const [sources, setSources] = useState<Record<string, string>>({});

  useEffect(() => {
    let active = true;
    const requestedPaths = pathKey ? pathKey.split("\0") : [];
    Promise.all(
      requestedPaths.map(async (path) => {
        const relative = relativePath(cwd, path);
        if (!relative) return null;
        try {
          return [path, await readTextFile(cwd, relative)] as const;
        } catch {
          return null;
        }
      }),
    ).then((files) => {
      if (active) setSources(Object.fromEntries(files.filter((file) => file !== null)));
    });
    return () => {
      active = false;
    };
  }, [cwd, pathKey]);

  const diffs = changes.flatMap((change) => {
    const source = sources[change.path];
    const diff = source && buildContextualDiff(source, change.oldText, change.newText, change.path);
    return diff ? [diff] : [];
  });
  if (!diffs.length) return fallback ? <>{fallback}</> : null;

  return (
    <div>
      {diffs.map((diff, index) => (
        <div
          key={`${diff.filePath}-${index}`}
          className="border-t border-[var(--pi-border-muted)] first:border-t-0"
        >
          <DiffHeader filePath={diff.filePath} added={diff.added} removed={diff.removed} />
          <StructuredDiffView diff={diff} />
        </div>
      ))}
    </div>
  );
}
