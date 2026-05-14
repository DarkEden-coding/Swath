import type { AppConfig } from "../../shared/types";

export const configClient = {
  load: (): Promise<AppConfig> => window.swath.config.load(),
  save: (config: AppConfig): Promise<void> => window.swath.config.save(config),
};
