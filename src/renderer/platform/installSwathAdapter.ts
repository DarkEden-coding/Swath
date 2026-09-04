import type { SwathApi } from "../../shared/ipc/swath";
import { createBrowserStubSwath } from "./browserFixture";
import { isTauriRuntime } from "./runtime";
import { createTauriSwath } from "./tauriAdapter";
import { createHybridSwath, createRemoteWebSwath } from "./remoteAdapter";

type SwathWindow = Window & { swath: SwathApi };

/** Installs the appropriate bridge once; production never receives the demo stub. */
export function attachSwathAdapterIfMissing(): void {
  if (typeof window === "undefined" || ("swath" in window && window.swath)) return;

  if (isTauriRuntime()) {
    (window as SwathWindow).swath = createHybridSwath(createTauriSwath());
  } else if (location.pathname !== "/" || new URLSearchParams(location.search).has("fixture")) {
    (window as SwathWindow).swath = createBrowserStubSwath();
  } else if (!import.meta.env.DEV || new URLSearchParams(location.search).has("remote")) {
    (window as SwathWindow).swath = createRemoteWebSwath();
  } else if (import.meta.env.DEV) {
    (window as SwathWindow).swath = createBrowserStubSwath();
  }
}
