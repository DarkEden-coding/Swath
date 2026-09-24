declare module "@tauri-apps/api/core" {
  export function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  export function convertFileSrc(path: string): string;
  export function isTauri(): boolean;
}

declare module "@tauri-apps/api/event" {
  export interface Event<T> {
    payload: T;
  }

  export function listen<T>(event: string, handler: (event: Event<T>) => void): Promise<() => void>;
}

declare namespace JSX {
  type Element = import("react").ReactElement;
}

type SwathApi = import("../shared/ipc/swath").SwathApi;

interface Window {
  swath: SwathApi;
}
