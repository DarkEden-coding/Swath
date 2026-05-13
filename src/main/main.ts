import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import { loadConfig, saveConfig } from "./configStore";
import { TerminalSessionManager } from "./ptyManager";
import type {
  AppConfig,
  FolderSelectResult,
  PtyCreateRequest,
  PtyResizeRequest,
  TerminalSessionAttachRequest,
} from "./sharedTypes";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
let ptyManager: TerminalSessionManager | null = null;

function getAppIconPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "icon.png")
    : path.join(process.cwd(), "icon.png");
}

app.setName("Swath");

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#0d1117",
    show: false,
    icon: getAppIconPath(),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    trafficLightPosition: { x: 16, y: 12 },
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  ptyManager = new TerminalSessionManager(mainWindow);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  mainWindow.on("close", (event) => {
    if (!ptyManager?.hasRunningSessions()) return;
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: "warning",
      buttons: ["Cancel", "Kill Terminals and Close"],
      defaultId: 0,
      cancelId: 0,
      message: "Terminal sessions are still running.",
      detail: "Closing the app will kill all running terminal processes.",
    });
    if (choice === 0) event.preventDefault();
  });

  mainWindow.on("closed", () => {
    ptyManager?.killAll();
    ptyManager = null;
    mainWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

function sendCommand(command: string): void {
  mainWindow?.webContents.send("app:command", command);
}

function createMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { role: "services" as const },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "hideOthers" as const },
              { role: "unhide" as const },
              { type: "separator" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Add Workspace",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => sendCommand("workspace:add"),
        },
        {
          label: "New Terminal Tab",
          accelerator: "CmdOrCtrl+T",
          click: () => sendCommand("tab:new"),
        },
        {
          label: "Close Terminal Tab",
          accelerator: "CmdOrCtrl+W",
          click: () => sendCommand("tab:close"),
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Terminal",
      submenu: [
        {
          label: "Split Right",
          accelerator: "CmdOrCtrl+\\",
          click: () => sendCommand("pane:split-right"),
        },
        {
          label: "Split Down",
          accelerator: "CmdOrCtrl+Shift+\\",
          click: () => sendCommand("pane:split-down"),
        },
        {
          label: "Close Pane",
          accelerator: "CmdOrCtrl+Shift+W",
          click: () => sendCommand("pane:close"),
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  if (process.platform === "darwin") app.dock?.setIcon(getAppIconPath());

  ipcMain.handle("config:load", async () => loadConfig());
  ipcMain.handle("config:save", async (_event, config: AppConfig) =>
    saveConfig(config),
  );
  ipcMain.handle(
    "dialog:select-folder",
    async (): Promise<FolderSelectResult> => {
      const result = await dialog.showOpenDialog(mainWindow!, {
        properties: ["openDirectory", "createDirectory"],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { canceled: true, path: null, name: null };
      }

      const selectedPath = result.filePaths[0];
      return {
        canceled: false,
        path: selectedPath,
        name: path.basename(selectedPath) || selectedPath,
      };
    },
  );

  ipcMain.on("pty:create", (_event, request: PtyCreateRequest) =>
    ptyManager?.create(request),
  );
  ipcMain.on("pty:write", (_event, sessionId: string, data: string) =>
    ptyManager?.write(sessionId, data),
  );
  ipcMain.on("pty:resize", (_event, request: PtyResizeRequest) =>
    ptyManager?.resize(request),
  );
  ipcMain.on("pty:kill", (_event, sessionId: string) =>
    ptyManager?.kill(sessionId),
  );

  ipcMain.handle("terminal-session:attach", (_event, request: TerminalSessionAttachRequest) =>
    ptyManager?.attach(request),
  );
  ipcMain.handle("terminal-session:restart", (_event, sessionId: string) =>
    ptyManager?.restart(sessionId),
  );
  ipcMain.handle("terminal-session:replay", (_event, sessionId: string) =>
    ptyManager?.replay(sessionId),
  );
  ipcMain.handle("terminal-session:is-running", (_event, sessionId: string) =>
    ptyManager?.isRunning(sessionId) ?? false,
  );
  ipcMain.on("terminal-session:write", (_event, sessionId: string, data: string) =>
    ptyManager?.write(sessionId, data),
  );
  ipcMain.on("terminal-session:resize", (_event, request: PtyResizeRequest) =>
    ptyManager?.resize(request),
  );
  ipcMain.on("terminal-session:kill", (_event, sessionId: string) =>
    ptyManager?.kill(sessionId),
  );

  createWindow();
  createMenu();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
