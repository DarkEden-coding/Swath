import { spawnSync } from "node:child_process";
import path from "node:path";

export function normalizeProcessName(value: string | undefined | null): string {
  return path.basename((value ?? "").trim()).replace(/^-/u, "").replace(/\.exe$/iu, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function matchesShellProcess(activeProcess: string | undefined | null, shellCommand: string): boolean {
  const active = normalizeProcessName(activeProcess);
  const shell = normalizeProcessName(shellCommand);
  if (!active || !shell) return false;
  return active === shell || active.includes(shell) || shell.includes(active);
}

export function hasChildProcesses(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", `@(Get-CimInstance Win32_Process -Filter \"ParentProcessId=${pid}\").Count`], { encoding: "utf8" });
      return Number((result.stdout ?? "").toString().trim()) > 0;
    }
    const result = spawnSync("ps", ["-o", "pid=", "--ppid", String(pid)], { encoding: "utf8" });
    return Boolean((result.stdout ?? "").toString().trim());
  } catch {
    return false;
  }
}
