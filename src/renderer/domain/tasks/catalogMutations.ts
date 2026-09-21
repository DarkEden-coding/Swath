import { reportError } from "../../lib/errorLog";
import { useTaskStore } from "../../state/taskStore";

const pendingPaneOrders = new Map<string, string[]>();
const runningPaneOrders = new Set<string>();

function replyError(reply: unknown): string | null {
  if (!reply || typeof reply !== "object") return null;
  const value = reply as { ok?: boolean; code?: unknown; error?: unknown };
  if (value.ok !== false) return null;
  return [value.code, value.error].filter((item) => typeof item === "string").join(": ") ||
    "Catalog mutation failed";
}

async function flushPaneOrder(taskId: string): Promise<void> {
  if (runningPaneOrders.has(taskId)) return;
  runningPaneOrders.add(taskId);
  try {
    while (pendingPaneOrders.has(taskId)) {
      const order = pendingPaneOrders.get(taskId)!;
      pendingPaneOrders.delete(taskId);
      try {
        const reply = await window.swath.tasks.rpc({
          op: "reorderPanes",
          taskId,
          paneIds: order,
          operationId: crypto.randomUUID(),
        });
        const error = replyError(reply);
        if (error) throw new Error(error);
        await useTaskStore.getState().refresh();
      } catch (error) {
        reportError("Reordering task tabs", error);
        try {
          await useTaskStore.getState().refresh();
        } catch (refreshError) {
          reportError("Refreshing task tabs after reorder failure", refreshError);
        }
      }
    }
  } finally {
    runningPaneOrders.delete(taskId);
    // A refresh above loaded the authoritative order. Remove the optimistic overlay only after all
    // coalesced drag gestures have settled, avoiding flicker or an older reply winning the race.
    if (!pendingPaneOrders.has(taskId)) {
      useTaskStore.getState().setPaneOrderOverride(taskId, null);
    } else {
      void flushPaneOrder(taskId);
    }
  }
}

/** Coalesces rapid drag gestures and serializes revision-fenced writes for one task. */
export function reorderTaskPanes(taskId: string, order: string[]): void {
  useTaskStore.getState().setPaneOrderOverride(taskId, order);
  pendingPaneOrders.set(taskId, order);
  void flushPaneOrder(taskId);
}

