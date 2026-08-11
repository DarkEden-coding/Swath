import { create } from "zustand";
import type { AppConfig } from "../../shared/types";
import { configClient } from "../services/configClient";
import { getActiveWorkspaceId } from "../domain/workspaces/workspaceActions";
import { sanitizeConfig } from "../domain/config/configSanitizer";
import { reportError } from "../lib/errorLog";

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
    const loaded = await configClient.load();
    // Stored layouts can name tab types this build no longer ships; drop them before anything
    // renders, and write the repair back so the config stops carrying them.
    const { config, changed, removedKinds } = sanitizeConfig(loaded);
    const normalized = { ...config, activeWorkspaceId: getActiveWorkspaceId(config) };
    set({ config: normalized, loaded: true });
    if (changed) {
      reportError("Config", `removed unsupported pane kinds: ${removedKinds.join(", ")}`);
      void configClient.save(normalized);
    }
    return normalized;
  },
  setConfig: (config) => set({ config }),
  save: async (config) => {
    const target = config ?? get().config;
    if (target) await configClient.save(target);
  },
}));
