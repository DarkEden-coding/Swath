import type { AppConfig } from "../../shared/types";

export const configClient = {
  snapshot: () => window.swath.config.snapshot(),
  commit: (request: import("../../shared/ipc/swath").ConfigSnapshot) =>
    window.swath.config.commit(request),
  onChanged: (callback: (event: { revision: number }) => void) =>
    window.swath.config.onChanged(callback),
  load: (): Promise<AppConfig> => window.swath.config.load(),
  save: (config: AppConfig): Promise<void> => window.swath.config.save(config),
};
