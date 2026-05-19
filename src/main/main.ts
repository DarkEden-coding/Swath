import { app, BrowserWindow, dialog } from "electron";
import { createMainWindow } from "./app/createWindow";
import { createApplicationMenu } from "./app/menu";
import { registerIpc } from "./ipc/registerIpc";
import { TerminalSessionManager } from "./services/terminalSessionManager";

let mainWindow: BrowserWindow | null = null;
let ptyManager: TerminalSessionManager | null = null;
let isQuitting = false;

app.setName("Swath");

function wireWindowLifecycle(window: BrowserWindow): void {
  window.on("close", (event) => {
    if (isQuitting) return;
    if (ptyManager?.hasRunningSessions()) {
      const choice = dialog.showMessageBoxSync(window, {
        type: "warning",
        buttons: ["Cancel", "Kill Terminals and Close"],
        defaultId: 0,
        cancelId: 0,
        message: "Terminal sessions are still running.",
        detail: "Closing the app will kill all running terminal processes."
      });
      if (choice === 0) {
        event.preventDefault();
        return;
      }
    }
    isQuitting = true;
    app.quit();
  });

  window.on("closed", () => {
    ptyManager?.killAll();
    ptyManager = null;
    mainWindow = null;
  });
}

function openMainWindow(): void {
  mainWindow = createMainWindow();
  ptyManager = new TerminalSessionManager(mainWindow);
  wireWindowLifecycle(mainWindow);
}

app.whenReady().then(() => {
  registerIpc({
    getMainWindow: () => mainWindow,
    getTerminalManager: () => ptyManager
  });

  openMainWindow();
  createApplicationMenu(() => mainWindow);

  app.on("before-quit", () => {
    isQuitting = true;
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) openMainWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
