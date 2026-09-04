import { create } from "zustand";

const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_HARD_MAX = 560;
const SIDEBAR_WIDTH_STORAGE_KEY = "swath.sidebarWidthPx";

/** Constrains the sidebar divider to usable bounds for the current window. */
function clampSidebarWidthPx(width: number): number {
  const max = Math.max(
    SIDEBAR_WIDTH_MIN,
    Math.min(SIDEBAR_WIDTH_HARD_MAX, Math.floor(window.innerWidth * 0.5)),
  );
  return Math.round(Math.max(SIDEBAR_WIDTH_MIN, Math.min(max, width)));
}

/** Restores the last sidebar divider position when available. */
function loadSidebarWidthPx(): number {
  try {
    const savedWidth = Number.parseFloat(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? "");
    return Number.isFinite(savedWidth) ? clampSidebarWidthPx(savedWidth) : 268;
  } catch {
    return 268;
  }
}

/** Saves the sidebar divider position without blocking UI updates on storage errors. */
function saveSidebarWidthPx(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width));
  } catch {
    // The divider remains usable when browser storage is unavailable.
  }
}

interface UiState {
  sidebarQuery: string;
  settingsOpen: boolean;
  remoteConnectOpen: boolean;
  activePaneId: string | null;
  sidebarCollapsed: boolean;
  sidebarWidthPx: number;
  setSidebarQuery: (query: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
  openRemoteConnect: () => void;
  closeRemoteConnect: () => void;
  setActivePaneId: (paneId: string | null) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarWidthPx: (width: number) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarQuery: "",
  settingsOpen: false,
  remoteConnectOpen: false,
  activePaneId: null,
  sidebarCollapsed: false,
  sidebarWidthPx: loadSidebarWidthPx(),
  setSidebarQuery: (sidebarQuery) => set({ sidebarQuery }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openRemoteConnect: () => set({ remoteConnectOpen: true }),
  closeRemoteConnect: () => set({ remoteConnectOpen: false }),
  setActivePaneId: (activePaneId) => set({ activePaneId }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarWidthPx: (width) => {
    const sidebarWidthPx = clampSidebarWidthPx(width);
    saveSidebarWidthPx(sidebarWidthPx);
    set({ sidebarWidthPx });
  },
}));
