import type { BrowserWindow } from "electron";
import { registerClipboardIpc } from "./clipboardIpc";
import { registerConfigIpc } from "./configIpc";
import { registerDialogIpc } from "./dialogIpc";
import { registerGitIpc } from "./gitIpc";
import { registerPermissionsIpc } from "./permissionsIpc";
import { registerTerminalIpc } from "./terminalIpc";
import type { TerminalSessionManager } from "../ptyManager";

interface RegisterIpcOptions {
  getMainWindow: () => BrowserWindow | null;
  getTerminalManager: () => TerminalSessionManager | null;
}

export function registerIpc({ getMainWindow, getTerminalManager }: RegisterIpcOptions): void {
  registerConfigIpc();
  registerClipboardIpc();
  registerPermissionsIpc();
  registerDialogIpc({ getMainWindow });
  registerGitIpc();
  registerTerminalIpc({ getTerminalManager });
}
