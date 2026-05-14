import { app, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import { IpcChannels } from "../../shared/ipc";

function sendCommand(window: BrowserWindow | null, command: string): void {
  window?.webContents.send(IpcChannels.appCommand, command);
}

export function createApplicationMenu(getWindow: () => BrowserWindow | null): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin" ? [{ label: app.name, submenu: [{ role: "about" as const }, { type: "separator" as const }, { role: "services" as const }, { type: "separator" as const }, { role: "hide" as const }, { role: "hideOthers" as const }, { role: "unhide" as const }, { type: "separator" as const }, { role: "quit" as const }] }] : []),
    { label: "Edit", submenu: [{ role: "undo" }, { role: "redo" }, { type: "separator" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "pasteAndMatchStyle" }, { role: "delete" }, { type: "separator" }, { role: "selectAll" }] },
    { label: "File", submenu: [
      { label: "Add Workspace", accelerator: "CmdOrCtrl+Shift+O", click: () => sendCommand(getWindow(), "workspace:add") },
      { label: "New Workspace View", accelerator: "CmdOrCtrl+T", click: () => sendCommand(getWindow(), "view:new") },
      { label: "Close Workspace View", accelerator: "CmdOrCtrl+W", click: () => sendCommand(getWindow(), "view:close") },
      { type: "separator" }, process.platform === "darwin" ? { role: "close" } : { role: "quit" }
    ] },
    { label: "Terminal", submenu: [
      { label: "Split Right", accelerator: "CmdOrCtrl+\\", click: () => sendCommand(getWindow(), "pane:split-right") },
      { label: "Split Down", accelerator: "CmdOrCtrl+Shift+\\", click: () => sendCommand(getWindow(), "pane:split-down") },
      { label: "Close Pane", accelerator: "CmdOrCtrl+Shift+W", click: () => sendCommand(getWindow(), "pane:close") }
    ] },
    { label: "View", submenu: [{ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" }, { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" }, { role: "togglefullscreen" }] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
