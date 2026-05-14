import { ipcMain } from "electron";
import { IpcChannels } from "../../shared/ipc";
import { readClipboardForTerminal } from "../services/clipboardService";

export function registerClipboardIpc(): void {
  ipcMain.handle(IpcChannels.clipboardReadForTerminal, readClipboardForTerminal);
}
