import { create } from "zustand";
import type { AppConfig } from "../../shared/types";
import { configClient } from "../services/configClient";
import { getActiveWorkspaceId } from "../domain/workspaces/workspaceActions";

interface ConfigState {
  config: AppConfig | null;
  loaded: boolean;
  hydrate: () => Promise<AppConfig>;
  setConfig: (config: AppConfig) => void;
  save: (config?: AppConfig) => Promise<void>;
}

export const useConfigStore = create<ConfigState>((set, get) => ({
  config: null,
  loaded: false,
  hydrate: async () => {
    const config = await configClient.load();
    const normalized = { ...config, activeWorkspaceId: getActiveWorkspaceId(config) };
    set({ config: normalized, loaded: true });
    return normalized;
  },
  setConfig: (config) => set({ config }),
  save: async (config) => {
    const target = config ?? get().config;
    if (target) await configClient.save(target);
  },
}));
