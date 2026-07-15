export interface TerminalPastePayload {
  text: string;
  hasImage: boolean;
}

export interface ClipboardDataEvent {
  clipboardData?: {
    getData: (type: string) => string;
    files?: ArrayLike<File | { path?: string }>;
  } | null;
}

/** Identify the quoting rules used by a configured shell. */
function shellKind(shellCommand: string | undefined): "cmd" | "powershell" | "posix" {
  const commandName = shellCommand
    ?.split(/[\\/]/)
    .pop()
    ?.toLowerCase()
    .replace(/\.exe$/, "");
  if (commandName === "cmd") return "cmd";
  if (commandName === "powershell" || commandName === "pwsh") return "powershell";
  return "posix";
}

/** Quote a filesystem path for safe insertion into the configured shell. */
export function shellQuotePath(path: string, shellCommand?: string): string {
  const kind = shellKind(shellCommand);
  if (kind === "cmd") return `"${path.replaceAll('"', '""')}"`;
  if (kind === "powershell") return `'${path.replaceAll("'", "''")}'`;
  return `'${path.replaceAll("'", "'\\''")}'`;
}

/** Format filesystem paths as a space-delimited shell paste. */
export function formatPathPaste(paths: string[], shellCommand?: string): string {
  return paths.map((path) => shellQuotePath(path, shellCommand)).join(" ");
}

/** Read plain text from a clipboard event-like object. */
export function getClipboardEventText(event: ClipboardDataEvent): string {
  return event.clipboardData?.getData("text/plain") ?? "";
}

/** Read Electron filesystem paths exposed by clipboard files. */
export function getClipboardEventFilePaths(event: ClipboardDataEvent): string[] {
  const files = Array.from(event.clipboardData?.files ?? []);
  return files
    .map((file) => (file as File & { path?: string }).path)
    .filter((path): path is string => Boolean(path));
}

/** Read the native clipboard payload used by terminal paste handling. */
export async function readTerminalPastePayload(): Promise<TerminalPastePayload> {
  return window.swath.clipboard.readForTerminal();
}
