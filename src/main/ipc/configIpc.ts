import { ipcMain } from "electron";
import { IpcChannels, appConfigSchema } from "../../shared/ipc";
import type { AppConfig } from "../../shared/types";
import { loadConfig, saveConfig } from "../services/configStore";

export function registerConfigIpc(): void {
  ipcMain.handle(IpcChannels.configLoad, async () => loadConfig());
  ipcMain.handle(IpcChannels.configSave, async (_event, config: AppConfig) =>
    saveConfig(appConfigSchema.parse(config) as AppConfig),
  );
}
