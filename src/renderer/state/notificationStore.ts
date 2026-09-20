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
