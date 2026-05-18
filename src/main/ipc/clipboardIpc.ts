import { ipcMain } from "electron";
import { IpcChannels } from "../../shared/ipc";
import { readClipboardForTerminal, writeClipboardText } from "../services/clipboardService";

export function registerClipboardIpc(): void {
  ipcMain.handle(IpcChannels.clipboardReadForTerminal, readClipboardForTerminal);
  ipcMain.handle(IpcChannels.clipboardWriteText, (_event, text: string) => writeClipboardText(text));
}
