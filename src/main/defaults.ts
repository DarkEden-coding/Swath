import os from "node:os";
import type { AppConfig, ShellProfile } from "../shared/types";

export function defaultShellProfiles(): ShellProfile[] {
  if (process.platform === "win32") {
    return [
      {
        id: "powershell",
        name: "PowerShell",
        command: "powershell.exe",
        args: ["-NoLogo"]
      },
      {
        id: "cmd",
        name: "Command Prompt",
        command: "cmd.exe",
        args: []
      },
      {
        id: "pwsh",
        name: "PowerShell 7",
        command: "pwsh.exe",
        args: ["-NoLogo"]
      }
    ];
  }

  return [
    {
      id: "default",
      name: "Default shell",
      command: process.env.SHELL || "/bin/zsh",
      args: ["-l"]
    },
    {
      id: "zsh",
      name: "zsh",
      command: "/bin/zsh",
      args: ["-l"]
    },
    {
      id: "bash",
      name: "bash",
      command: "/bin/bash",
      args: ["-l"]
    }
  ];
}

export function createDefaultConfig(): AppConfig {
  const shellProfiles = defaultShellProfiles();

  return {
    version: 2,
    workspaces: [],
    activeWorkspaceId: null,
    settings: {
      fontFamily:
        process.platform === "win32"
          ? "'JetBrains Mono', 'Cascadia Mono', Consolas, monospace"
          : "'JetBrains Mono', 'Fira Code', 'SF Mono', Menlo, Monaco, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: "block",
      defaultShellProfileId: shellProfiles[0]?.id ?? "default",
      shellProfiles,
      globalEnv: {},
      confirmBeforeClosingPane: false
    }
  };
}

export function homeWorkspacePath(): string {
  return os.homedir();
}
