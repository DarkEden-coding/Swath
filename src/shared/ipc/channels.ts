export const IpcChannels = {
  configLoad: "config:load",
  configSave: "config:save",
  clipboardReadForTerminal: "clipboard:read-for-terminal",
  clipboardWriteText: "clipboard:write-text",
  permissionsEnsureTerminalPaste: "permissions:ensure-terminal-paste",
  dialogSelectFolder: "dialog:select-folder",
  terminalCreate: "terminal:create",
  terminalWrite: "terminal:write",
  terminalResize: "terminal:resize",
  terminalKill: "terminal:kill",
  terminalAttach: "terminal:attach",
  terminalRestart: "terminal:restart",
  terminalReplay: "terminal:replay",
  terminalIsBusy: "terminal:is-busy",
  terminalData: "terminal:data",
  terminalExit: "terminal:exit",
  appCommand: "app:command",
  gitRpc: "git:rpc"
} as const;

export type IpcChannel = (typeof IpcChannels)[keyof typeof IpcChannels];
