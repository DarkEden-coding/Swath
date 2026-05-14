import { create } from "zustand";

interface UiState {
  sidebarQuery: string;
  settingsOpen: boolean;
  activePaneId: string | null;
  sidebarCollapsed: boolean;
  setSidebarQuery: (query: string) => void;
  openSettings: () => void;
  closeSettings: () => void;
  setActivePaneId: (paneId: string | null) => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  toggleSidebarCollapsed: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  sidebarQuery: "",
  settingsOpen: false,
  activePaneId: null,
  sidebarCollapsed: false,
  setSidebarQuery: (sidebarQuery) => set({ sidebarQuery }),
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  setActivePaneId: (activePaneId) => set({ activePaneId }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  toggleSidebarCollapsed: () => set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }))
}));
