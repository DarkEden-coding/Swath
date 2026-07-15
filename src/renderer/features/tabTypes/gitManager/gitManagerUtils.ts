import type { GitPathEntry, GitStatusResult } from "../../../services/gitClient";

/** Removes duplicate Git status entries and sorts them by path. */
export function uniqueSortedPaths(entries: GitPathEntry[]): GitPathEntry[] {
  const byPath = new Map<string, GitPathEntry>();
  for (const entry of entries) if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** Returns the sorted paths which can be staged from a status response. */
export function changePaths(status: GitStatusResult): string[] {
  if (!status.ok) return [];
  return [...new Set([...status.unstaged.map((entry) => entry.path), ...status.untracked])].sort(
    (a, b) => a.localeCompare(b),
  );
}

/**
 * Appends git CLI output while honoring carriage-return progress updates.
 *
 * Git prints progress as `Counting objects: 1%\rCounting objects: 2%\r...done.\n`.
 * A real terminal overwrites the line on each `\r`; this keeps the same behavior
 * so the log shows the latest progress line instead of every percentage.
 */
export function appendGitTerminalText(previous: string, chunk: string): string {
  if (!chunk) return previous;

  const lastNewline = previous.lastIndexOf("\n");
  let completed = lastNewline >= 0 ? previous.slice(0, lastNewline + 1) : "";
  let current = lastNewline >= 0 ? previous.slice(lastNewline + 1) : previous;

  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index];
    if (char === "\r") {
      if (chunk[index + 1] === "\n") {
        completed += `${current.replace(/\s+$/u, "")}\n`;
        current = "";
        index += 1;
      } else {
        current = "";
      }
      continue;
    }
    if (char === "\n") {
      completed += `${current.replace(/\s+$/u, "")}\n`;
      current = "";
      continue;
    }
    current += char;
  }

  return completed + current;
}

/** Collapses carriage-return progress sequences in a finished git output blob. */
export function normalizeGitTerminalText(text: string): string {
  return appendGitTerminalText("", text);
}

/** Selects the file-extension accent used by change rows. */
export function extAccentClass(path: string): string {
  const lower = path.toLowerCase();
  if (lower.endsWith(".tsx") || lower.endsWith(".jsx")) return "bg-swath-accent";
  if (lower.endsWith(".ts") || lower.endsWith(".js")) return "bg-swath-accent-strong";
  if (lower.endsWith(".css")) return "bg-swath-warn";
  if (lower.endsWith(".json") || lower.endsWith(".md")) return "bg-swath-good";
  return "bg-swath-muted-2";
}

/** Selects the semantic color for a porcelain status letter. */
export function statusLetterClass(isStaged: boolean, letter: string): string {
  if (letter === "D") return "text-swath-danger";
  if (letter === "A" || letter === "?") return "text-swath-good";
  return isStaged ? "text-swath-good" : "text-swath-warn";
}

/** Parses the comma-separated decoration returned by git log. */
export function refTokens(refs: string): string[] {
  return refs.trim()
    ? refs
        .split(",")
        .map((ref) => ref.trim())
        .filter(Boolean)
    : [];
}

/** Removes Git's decoration prefixes from a ref for display. */
export function simplifyRefLabel(ref: string): string {
  if (ref.startsWith("HEAD -> ")) return ref.slice(8);
  if (ref.startsWith("tag: ")) return ref.slice(5);
  return ref;
}

/** Selects the badge treatment for a branch, remote, or tag decoration. */
export function refBadgeClass(ref: string): string {
  const lower = ref.toLowerCase();
  if (lower.includes("origin/") || lower.includes("remote/"))
    return "border-swath-border bg-swath-panel-2 text-swath-muted";
  if (lower.startsWith("tag: ")) return "border-swath-warn/50 bg-swath-panel-2 text-swath-warn";
  return "border-swath-accent/40 bg-swath-accent/10 text-swath-accent-strong";
}
