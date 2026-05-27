import type { BrowserWindow } from "electron";
import { registerBrowserIpc } from "./browserIpc";
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
  registerBrowserIpc();
  registerConfigIpc();
  registerClipboardIpc();
  registerPermissionsIpc();
  registerDialogIpc({ getMainWindow });
  registerGitIpc();
  registerTerminalIpc({ getTerminalManager });
}
