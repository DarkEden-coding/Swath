import { ipcMain, dialog, type BrowserWindow } from "electron";
import path from "node:path";
import { IpcChannels } from "../../shared/ipc";
import type { FolderSelectResult } from "../../shared/types";

interface RegisterDialogIpcOptions {
  getMainWindow: () => BrowserWindow | null;
}

export function registerDialogIpc({ getMainWindow }: RegisterDialogIpcOptions): void {
  ipcMain.handle(IpcChannels.dialogSelectFolder, async (): Promise<FolderSelectResult> => {
    const win = getMainWindow();
    if (!win) return { canceled: true, path: null, name: null };
    const result = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
    if (result.canceled || result.filePaths.length === 0) return { canceled: true, path: null, name: null };
    const selectedPath = result.filePaths[0]!;
    return { canceled: false, path: selectedPath, name: path.basename(selectedPath) || selectedPath };
  });
}
