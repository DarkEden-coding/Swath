import type { SwathApi } from "../../shared/ipc/swath";
import { createBrowserStubSwath } from "./browserFixture";
import { isTauriRuntime } from "./runtime";
import { createTauriSwath } from "./tauriAdapter";

type SwathWindow = Window & { swath: SwathApi };

/** Installs the appropriate bridge once; production never receives the demo stub. */
export function attachSwathAdapterIfMissing(): void {
  if (typeof window === "undefined" || ("swath" in window && window.swath)) return;

  if (isTauriRuntime()) {
    (window as SwathWindow).swath = createTauriSwath();
  } else if (import.meta.env.DEV) {
    (window as SwathWindow).swath = createBrowserStubSwath();
  }
}
