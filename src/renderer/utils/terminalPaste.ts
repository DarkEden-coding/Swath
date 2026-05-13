import type { ClipboardEvent } from "react";

export function shellQuotePath(path: string): string {
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function formatPathPaste(paths: string[]): string {
  return paths.map(shellQuotePath).join(" ");
}

export function getClipboardEventText(event: ClipboardEvent<HTMLElement>): string {
  return event.clipboardData?.getData("text/plain") ?? "";
}

export function getClipboardEventFilePaths(event: ClipboardEvent<HTMLElement>): string[] {
  const files = Array.from(event.clipboardData?.files ?? []);
  return files
    .map((file) => (file as File & { path?: string }).path)
    .filter((path): path is string => Boolean(path));
}
