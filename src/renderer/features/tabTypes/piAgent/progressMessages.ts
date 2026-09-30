import type { PiSessionEntry } from "../../../../shared/ipc/piRpc";

// The injected standalone extension uses this same widget/custom-entry key and limits.
export const PROGRESS_KEY = "swath:progress";
export const MAX_PROGRESS_MESSAGES = 50;
const MAX_MESSAGE_LENGTH = 500;

export interface PiProgressMessage {
  id: string;
  message: string;
  timestamp: number;
  role?: "user" | "agent";
}

/** Validates progress data received through widgets or persisted session entries. */
function readProgressMessage(value: unknown): PiProgressMessage | null {
  if (typeof value !== "object" || value === null) return null;
  const entry = value as Record<string, unknown>;
  if (
    typeof entry.id !== "string" ||
    !entry.id ||
    typeof entry.message !== "string" ||
    !entry.message.trim() ||
    (entry.role !== "user" && entry.message.length > MAX_MESSAGE_LENGTH) ||
    (entry.role !== undefined && entry.role !== "user" && entry.role !== "agent") ||
    typeof entry.timestamp !== "number" ||
    !Number.isFinite(entry.timestamp) ||
    entry.timestamp < 0 ||
    entry.timestamp > 8.64e15
  )
    return null;
  return {
    id: entry.id,
    message: entry.message,
    timestamp: entry.timestamp,
    ...(entry.role === "user" || entry.role === "agent" ? { role: entry.role } : {}),
  };
}

/** Projects user messages and agent reports from the same session tree, without duplicates. */
function progressMessageFromSessionEntry(entry: PiSessionEntry): PiProgressMessage | null {
  if (entry.type === "custom" && entry.customType === PROGRESS_KEY) {
    return readProgressMessage(entry.data);
  }
  if (entry.type !== "message" || entry.message?.role !== "user") return null;
  const content = entry.message.content;
  const message =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((block) =>
              block.type === "text" ? block.text : block.type === "image" ? "[Image attached]" : "",
            )
            .join("\n")
        : "";
  return readProgressMessage({
    id: `user:${entry.id}`,
    message,
    role: "user",
    timestamp: entry.message.timestamp ?? Date.parse(entry.timestamp ?? ""),
  });
}

/** Keeps message order stable when a repeated call id is replayed. */
function boundedMessages(messages: readonly PiProgressMessage[]): PiProgressMessage[] {
  return [...new Map(messages.map((message) => [message.id, message])).values()].slice(
    -MAX_PROGRESS_MESSAGES,
  );
}

/** Reads the extension's full snapshot, including an empty snapshot on session replacement. */
export function progressMessagesFromWidget(lines: readonly string[] = []): PiProgressMessage[] {
  const messages: PiProgressMessage[] = [];
  for (const line of lines) {
    try {
      const message = readProgressMessage(JSON.parse(line));
      if (message) messages.push(message);
    } catch {
      // Other hosts can display plain-text widgets; only our JSON records belong in this window.
    }
  }
  return boundedMessages(messages);
}

/** Restores only the active branch, preserving live updates newer than the history response. */
export function restoreProgressMessages(
  data: unknown,
  current: readonly PiProgressMessage[],
): PiProgressMessage[] {
  if (typeof data !== "object" || data === null) return [...current];
  const response = data as { entries?: unknown; leafId?: unknown };
  if (
    !Array.isArray(response.entries) ||
    (response.leafId !== null && typeof response.leafId !== "string")
  ) {
    return [...current];
  }
  const entries = new Map<string, PiSessionEntry>();
  const recordedIds = new Set<string>();
  for (const value of response.entries) {
    if (typeof value !== "object" || value === null) continue;
    const entry = value as PiSessionEntry;
    if (
      typeof entry.id !== "string" ||
      (entry.parentId !== null && typeof entry.parentId !== "string")
    )
      continue;
    entries.set(entry.id, entry);
    const message = progressMessageFromSessionEntry(entry);
    if (message) recordedIds.add(message.id);
  }
  const messages: PiProgressMessage[] = [];
  const visited = new Set<string>();
  let id = response.leafId;
  while (typeof id === "string" && !visited.has(id) && messages.length < MAX_PROGRESS_MESSAGES) {
    visited.add(id);
    const entry = entries.get(id);
    if (!entry) break;
    const message = progressMessageFromSessionEntry(entry);
    if (message) messages.push(message);
    id = entry.parentId;
  }
  // Recorded updates on abandoned branches must not leak into the active branch. Only updates
  // missing from this snapshot can be newer live events that raced its response.
  return boundedMessages([
    ...messages.reverse(),
    ...current.filter((message) => !recordedIds.has(message.id)),
  ]);
}
