import { reportError } from "../../lib/errorLog";
import { useTaskStore } from "../../state/taskStore";

interface PendingPaneOrder {
  order: string[];
  operationId: string;
}

const pendingPaneOrders = new Map<string, PendingPaneOrder>();
const runningPaneOrders = new Set<string>();

export function catalogReplyError(reply: unknown): string | null {
  if (reply instanceof Error) return catalogReplyError(reply.message);
  if (typeof reply === "string") {
    const text = reply.trim();
    if (!text) return "Catalog mutation failed";
    try {
      return catalogReplyError(JSON.parse(text));
    } catch {
      return text;
    }
  }
  if (!reply || typeof reply !== "object") return null;
  const value = reply as {
    ok?: unknown;
    code?: unknown;
    error?: unknown;
    message?: unknown;
  };
  if (value.ok === true) return null;
  const detail =
    value.error != null
      ? catalogReplyError(value.error)
      : typeof value.message === "string" && value.message
        ? value.message
        : null;
  if (value.ok === false || value.code != null || detail) {
    const code = typeof value.code === "string" && value.code ? value.code : null;
    return [code, detail].filter(Boolean).join(": ") || "Catalog mutation failed";
  }
  return null;
}

async function flushPaneOrder(taskId: string): Promise<void> {
  if (runningPaneOrders.has(taskId)) return;
  runningPaneOrders.add(taskId);
  let lastRefreshSucceeded = false;
  try {
    while (pendingPaneOrders.has(taskId)) {
      const pending = pendingPaneOrders.get(taskId)!;
      pendingPaneOrders.delete(taskId);
      const { order, operationId } = pending;
      const request = {
        op: "reorderPanes" as const,
        taskId,
        paneIds: order,
        operationId,
      };
      let mutationError: unknown;
      try {
        const reply = await window.swath.tasks.rpc(request);
        const error = catalogReplyError(reply);
        if (error) throw new Error(error);
      } catch (error) {
        mutationError = error;
        reportError("Reordering task tabs", error);
      }
      // A lost response is ambiguous: the server may have committed the write. Retry with the
      // same operation id so the catalog deduplicates it instead of creating a second mutation.
      if (mutationError) {
        try {
          const retry = await window.swath.tasks.rpc(request);
          const error = catalogReplyError(retry);
          if (error) throw new Error(error);
          mutationError = undefined;
        } catch (retryError) {
          reportError("Retrying task tab reorder", retryError);
        }
      }
      try {
        await useTaskStore.getState().refresh();
        lastRefreshSucceeded = true;
      } catch (refreshError) {
        lastRefreshSucceeded = false;
        reportError("Refreshing task tabs after reorder failure", refreshError);
      }
    }
  } finally {
    runningPaneOrders.delete(taskId);
    // A refresh above loaded the authoritative order. Remove the optimistic overlay only after all
    // coalesced drag gestures have settled, avoiding flicker or an older reply winning the race.
    // If both the mutation and reconciliation failed, retain the optimistic order. Clearing it
    // here would restore a stale catalog snapshot and silently discard the user's drag.
    if (!pendingPaneOrders.has(taskId) && lastRefreshSucceeded) {
      useTaskStore.getState().setPaneOrderOverride(taskId, null);
    } else {
      if (pendingPaneOrders.has(taskId)) void flushPaneOrder(taskId);
    }
  }
}

/** Coalesces rapid drag gestures and serializes revision-fenced writes for one task. */
export function reorderTaskPanes(taskId: string, order: string[]): void {
  useTaskStore.getState().setPaneOrderOverride(taskId, order);
  const previous = pendingPaneOrders.get(taskId);
  pendingPaneOrders.set(taskId, {
    order,
    // Calls coalesced before the worker starts are one drag gesture. A later call while a write
    // is in flight starts a new gesture and therefore gets a new id.
    operationId:
      previous && !runningPaneOrders.has(taskId) ? previous.operationId : crypto.randomUUID(),
  });
  void flushPaneOrder(taskId);
}
