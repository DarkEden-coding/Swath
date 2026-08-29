/**
 * The folders one pi pane may touch: its working directory, plus the other folders of its project
 * group.
 *
 * Passed through context rather than props because the consumers sit deep inside the transcript,
 * where a new prop would have to thread through every memoized row component.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";

const PiRootsContext = createContext<readonly string[]>([]);

export function PiRootsProvider({
  cwd,
  groupPaths,
  children,
}: {
  cwd: string;
  groupPaths: readonly string[];
  children: ReactNode;
}): JSX.Element {
  const roots = useMemo(
    () => [cwd, ...groupPaths.filter((path) => path && path !== cwd)],
    [cwd, groupPaths],
  );
  return <PiRootsContext.Provider value={roots}>{children}</PiRootsContext.Provider>;
}

/** Every folder of the pane's project, working directory first. */
export function usePiRoots(cwd: string): readonly string[] {
  const roots = useContext(PiRootsContext);
  // A pane rendered outside a provider (tests, fixtures) still knows its own folder.
  return roots.length > 0 ? roots : [cwd];
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Splits an absolute path into the root that contains it and the remainder.
 *
 * Returns null when no root does: the file belongs to neither this project nor its group, and
 * reading it is not this pane's business.
 */
export function resolveUnderRoots(
  roots: readonly string[],
  path: string,
): { root: string; relative: string } | null {
  const normalizedPath = normalize(path);
  if (!normalizedPath.startsWith("/") && !/^[a-zA-Z]:\//.test(normalizedPath))
    return { root: roots[0] ?? "", relative: normalizedPath };
  // Longest match first, so a root nested inside another wins.
  const ordered = [...roots].sort((a, b) => normalize(b).length - normalize(a).length);
  for (const root of ordered) {
    const normalizedRoot = normalize(root);
    if (normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`))
      return { root, relative: normalizedPath.slice(normalizedRoot.length + 1) };
  }
  return null;
}

/**
 * How a path in this project reads to a human: relative inside the working directory, and prefixed
 * with the owning folder's name inside a sibling, so two `src/index.ts` never look identical.
 */
export function displayPath(roots: readonly string[], path: string): string | null {
  const resolved = resolveUnderRoots(roots, path);
  if (!resolved) return null;
  if (resolved.root === roots[0]) return resolved.relative;
  const folder = normalize(resolved.root).split("/").pop();
  return folder ? `${folder}/${resolved.relative}` : resolved.relative;
}
