import { create } from "zustand";

export interface Notification {
  id: number;
  message: string;
}

interface NotificationState {
  notifications: Notification[];
  notifyError: (message: string) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  notifyError: (message) => {
    const id = nextId++;
    set((state) => ({ notifications: [...state.notifications, { id, message }] }));
    timers.set(
      id,
      globalThis.setTimeout(() => get().dismiss(id), 4_000),
    );
    return id;
  },
  dismiss: (id) => {
    const timer = timers.get(id);
    if (timer !== undefined) globalThis.clearTimeout(timer);
    timers.delete(id);
    set((state) => ({ notifications: state.notifications.filter((item) => item.id !== id) }));
  },
}));

export function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

/** Peer relays use this typed error when the task-owning device cannot be reached. */
export function isDeviceUnreachableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (!message) return false;
  try {
    const value = JSON.parse(message) as { code?: unknown; error?: { code?: unknown } };
    return value.code === "executor_unreachable" || value.error?.code === "executor_unreachable";
  } catch {
    return false;
  }
}
