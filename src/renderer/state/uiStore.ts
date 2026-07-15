import { create } from "zustand";

const SIDEBAR_WIDTH_MIN = 180;
const SIDEBAR_WIDTH_HARD_MAX = 560;

function clampSidebarWidthPx(width: number): number {
  const max = Math.max(
    SIDEBAR_WIDTH_MIN,
    Math.min(SIDEBAR_WIDTH_HARD_MAX, Math.floor(window.innerWidth * 0.5)),
  );
  return Math.round(Math.max(SIDEBAR_WIDTH_MIN, Math.min(max, width)));
}

interface UiState {
  sidebarQuery: string;
  settingsOpen: boolean;
  activePaneId: string | null;
  sidebarCollapsed: boolean;
  sidebarWidthPx: number;
  setSidebarQuery: (query: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
  setActivePaneId: (paneId: string | null) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
  setSidebarWidthPx: (width: number) => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarQuery: "",
  settingsOpen: false,
  activePaneId: null,
  sidebarCollapsed: false,
  sidebarWidthPx: 268,
  setSidebarQuery: (sidebarQuery) => set({ sidebarQuery }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  setActivePaneId: (activePaneId) => set({ activePaneId }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed })),
  setSidebarWidthPx: (width) => set({ sidebarWidthPx: clampSidebarWidthPx(width) }),
}));
