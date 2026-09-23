import { create } from "zustand";
import type { AppConfig } from "../../shared/types";
import type { ConfigSnapshot } from "../../shared/ipc/swath";
import { configClient } from "../services/configClient";
import { getActiveWorkspaceId } from "../domain/workspaces/workspaceActions";
import { sanitizeConfig } from "../domain/config/configSanitizer";
import { reportError } from "../lib/errorLog";

interface ConfigState {
  config: AppConfig | null;
  loaded: boolean;
  hydrate: () => Promise<AppConfig>;
  setConfig: (config: AppConfig) => void;
  mutate: (mutator: (config: AppConfig) => AppConfig) => void;
  save: (config?: AppConfig) => Promise<void>;
}

let snapshot: ConfigSnapshot | null = null;
let pending: Promise<void> = Promise.resolve();
let subscribed = false;
const queued: Array<(config: AppConfig) => AppConfig> = [];

function localNavigation(remote: AppConfig, local: AppConfig | null): AppConfig {
  const workspaces = remote.workspaces.map((workspace) => {
    const previous = local?.workspaces.find((item) => item.id === workspace.id);
    return {
      ...workspace,
      activeViewId: workspace.views.some((view) => view.id === previous?.activeViewId)
        ? previous!.activeViewId
        : workspace.activeViewId,
      views: workspace.views.map((view) => {
        const prior = previous?.views.find((item) => item.id === view.id);
        return {
          ...view,
          activePaneId:
            prior && JSON.stringify(view.layout).includes(`"${prior.activePaneId}"`)
              ? prior.activePaneId
              : view.activePaneId,
        };
      }),
    };
  });
  return {
    ...remote,
    workspaces,
    activeWorkspaceId: workspaces.some((item) => item.id === local?.activeWorkspaceId)
      ? local!.activeWorkspaceId
      : getActiveWorkspaceId(remote),
    remoteConnections: local?.remoteConnections ?? remote.remoteConnections ?? [],
  };
}

export const useConfigStore = create<ConfigState>((set, get) => {
  async function refresh(): Promise<AppConfig> {
    const next = await configClient.snapshot();
    if (snapshot && next.revision < snapshot.revision) return get().config!;
    const { config, changed, removedKinds } = sanitizeConfig(next.config);
    snapshot = next;
    const merged = localNavigation(config, get().config);
    set({
      config: queued.reduce((state, operation) => operation(structuredClone(state)), merged),
      loaded: true,
    });
    if (changed) {
      reportError("Config", `removed unsupported pane kinds: ${removedKinds.join(", ")}`);
      get().mutate((current) => ({ ...current, workspaces: merged.workspaces }));
    }
    return merged;
  }
  return {
    config: null,
    loaded: false,
    hydrate: async () => {
      if (!subscribed) {
        subscribed = true;
        configClient.onChanged(({ revision }) => {
          if (revision > (snapshot?.revision ?? -1))
            void pending
              .then(refresh)
              .catch((error: unknown) => reportError("Refreshing config", error));
        });
      }
      return refresh();
    },
    setConfig: (config) => set({ config }),
    mutate: (mutator) => {
      const current = get().config;
      if (!current) return;
      queued.push(mutator);
      set({ config: mutator(structuredClone(current)) });
      pending = pending
        .then(async () => {
          for (;;) {
            if (!snapshot) await refresh();
            const base = snapshot!;
            // Reapply the original operation to the latest authoritative revision, never to optimistic state.
            const config = mutator(localNavigation(structuredClone(base.config), get().config));
            if (window.swath.platform === "web") config.remoteConnections = [];
            try {
              const committed = await configClient.commit({ config, revision: base.revision });
              snapshot = committed;
              queued.shift();
              const merged = localNavigation(committed.config, get().config);
              set({
                config: queued.reduce(
                  (state, operation) => operation(structuredClone(state)),
                  merged,
                ),
              });
              return;
            } catch (error) {
              if (!String(error).toLowerCase().includes("conflict")) {
                queued.shift();
                throw error;
              }
              await refresh();
            }
          }
        })
        .catch((error: unknown) => {
          reportError("Saving config", error);
          void refresh().catch((refreshError: unknown) =>
            reportError("Refreshing config", refreshError),
          );
        });
    },
    save: async (config) => {
      if (config) get().mutate(() => config);
      await pending;
    },
  };
});
