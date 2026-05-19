import { ipcMain, dialog, type BrowserWindow } from "electron";
import path from "node:path";
import { IpcChannels } from "../../shared/ipc";
import type { ConfirmDialogRequest, FolderSelectResult } from "../../shared/types";

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

  ipcMain.handle(IpcChannels.dialogConfirm, async (_event, request: ConfirmDialogRequest): Promise<boolean> => {
    const win = getMainWindow();
    if (!win) return false;
    const confirmLabel = request.confirmLabel ?? "OK";
    const cancelLabel = request.cancelLabel ?? "Cancel";
    const result = await dialog.showMessageBox(win, {
      type: "warning",
      buttons: [cancelLabel, confirmLabel],
      defaultId: 0,
      cancelId: 0,
      message: request.message,
      detail: request.detail,
      noLink: true,
    });
    return result.response === 1;
  });
}
