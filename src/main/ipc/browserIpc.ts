import { ipcMain, shell } from "electron";
import { IpcChannels } from "../../shared/ipc";

export function registerBrowserIpc(): void {
  ipcMain.handle(IpcChannels.browserOpenExternal, async (_event, url: string): Promise<void> => {
    if (typeof url !== "string" || url.trim().length === 0) return;
    await shell.openExternal(url);
  });
}
