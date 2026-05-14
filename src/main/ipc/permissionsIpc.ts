import { ipcMain } from "electron";
import { IpcChannels } from "../../shared/ipc";
import { ensureTerminalPastePermissions } from "../services/permissionsService";

export function registerPermissionsIpc(): void {
  ipcMain.handle(IpcChannels.permissionsEnsureTerminalPaste, ensureTerminalPastePermissions);
}
