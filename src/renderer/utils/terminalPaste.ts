import type { ClipboardEvent } from "react";

function shellKind(shellCommand: string | undefined): "cmd" | "powershell" | "posix" {
  const commandName = shellCommand?.split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, "");
  if (commandName === "cmd") return "cmd";
  if (commandName === "powershell" || commandName === "pwsh") return "powershell";
  return "posix";
}

export function shellQuotePath(path: string, shellCommand?: string): string {
  const kind = shellKind(shellCommand);
  if (kind === "cmd") return `"${path.replaceAll('"', '""')}"`;
  if (kind === "powershell") return `'${path.replaceAll("'", "''")}'`;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

export function formatPathPaste(paths: string[], shellCommand?: string): string {
  return paths.map((path) => shellQuotePath(path, shellCommand)).join(" ");
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
