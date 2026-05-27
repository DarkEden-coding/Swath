import fs from "node:fs";
import os from "node:os";
import { BrowserWindow } from "electron";
import * as pty from "node-pty";
import type { IPty } from "node-pty";
import type {
  PtyResizeRequest,
  ShellProfile,
  TerminalSessionAttachRequest,
  TerminalSessionStartRequest,
  TerminalSessionStatus,
} from "../shared/types";
import { IpcChannels } from "../shared/ipc";
import { TERMINAL_REPLAY_MAX_BYTES } from "../shared/memoryLimits";
import { defaultShellProfiles } from "./defaults";
import { hasChildProcesses, matchesShellProcess } from "./services/terminalProcessInspector";

interface TerminalSession {
  id: string;
  request: TerminalSessionStartRequest;
  pty: IPty | null;
  shellCommand: string;
  replayChunks: string[];
  replayBytes: number;
  cols: number;
  rows: number;
}

export class TerminalSessionManager {
  private sessions = new Map<string, TerminalSession>();

  constructor(private readonly window: BrowserWindow) {}

  attach(request: TerminalSessionAttachRequest): TerminalSessionStatus {
    const session = this.ensureSession(request);
    if (!session.pty) this.startSession(session);
    if (request.replay !== false) this.sendReplay(session);
    return { sessionId: request.sessionId, running: Boolean(session.pty) };
  }

  create(request: TerminalSessionStartRequest): void {
    void this.attach({ ...request, replay: false });
  }

  replay(sessionId: string): TerminalSessionStatus {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, running: false };
    this.sendReplay(session);
    return { sessionId, running: Boolean(session.pty) };
  }

  restart(sessionId: string): TerminalSessionStatus {
    const session = this.sessions.get(sessionId);
    if (!session) return { sessionId, running: false };
    this.killPty(session);
    session.replayChunks = [];
    session.replayBytes = 0;
    this.startSession(session);
    return { sessionId, running: Boolean(session.pty) };
  }

  isBusy(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.pty) return false;
    if (hasChildProcesses(session.pty.pid)) return true;
    if (!session.pty.process) return false;
    return !matchesShellProcess(session.pty.process, session.shellCommand);
  }

  hasRunningSessions(): boolean {
    return [...this.sessions.values()].some((session) => this.isBusy(session.id));
  }

  write(sessionId: string, data: string): void {
    this.sessions.get(sessionId)?.pty?.write(data);
  }

  resize(request: PtyResizeRequest): void {
    const session = this.sessions.get(request.sessionId);
    if (!session) return;

    const cols = Math.max(2, Math.floor(request.cols));
    const rows = Math.max(1, Math.floor(request.rows));
    session.cols = cols;
    session.rows = rows;
    session.pty?.resize(cols, rows);
  }

  kill(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.killPty(session);
    this.sessions.delete(sessionId);
  }

  killAll(): void {
    for (const sessionId of [...this.sessions.keys()]) this.kill(sessionId);
  }

  private ensureSession(request: TerminalSessionStartRequest): TerminalSession {
    const existing = this.sessions.get(request.sessionId);
    if (existing) {
      existing.request = { ...existing.request, ...request };
      existing.cols = Math.max(2, Math.floor(request.cols || existing.cols));
      existing.rows = Math.max(1, Math.floor(request.rows || existing.rows));
      return existing;
    }

    const session: TerminalSession = {
      id: request.sessionId,
      request,
      pty: null,
      shellCommand: "",
      replayChunks: [],
      replayBytes: 0,
      cols: Math.max(2, Math.floor(request.cols || 120)),
      rows: Math.max(1, Math.floor(request.rows || 30)),
    };
    this.sessions.set(request.sessionId, session);
    return session;
  }

  private startSession(session: TerminalSession): void {
    if (session.pty) return;

    const cwd = fs.existsSync(session.request.cwd) ? session.request.cwd : os.homedir();
    const shell = this.normalizeShell(this.resolveShell(session.request.shellProfile ?? null));
    const env = {
      ...process.env,
      ...shell.env,
      ...session.request.env,
      TERM_PROGRAM: "swath",
      COLORTERM: "truecolor",
    } as NodeJS.ProcessEnv;

    let ptyProcess: IPty;
    try {
      ptyProcess = pty.spawn(shell.command, shell.args, {
        name: "xterm-256color",
        cols: session.cols,
        rows: session.rows,
        cwd,
        env,
      });
    } catch (error) {
      this.failSessionStart(session, shell, error);
      return;
    }

    session.shellCommand = shell.command;
    session.pty = ptyProcess;

    ptyProcess.onData((data) => {
      this.appendReplay(session, data);
      this.send(IpcChannels.terminalData, session.id, data);
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      session.pty = null;
      this.send(IpcChannels.terminalExit, session.id, { exitCode, signal });
    });
  }

  private appendReplay(session: TerminalSession, data: string): void {
    if (data.includes("\x1bc") || data.includes("\x1b[2J") || data.includes("\x1b[3J")) {
      session.replayChunks = [];
      session.replayBytes = 0;
    }
    session.replayChunks.push(data);
    session.replayBytes += Buffer.byteLength(data);
    while (session.replayBytes > TERMINAL_REPLAY_MAX_BYTES && session.replayChunks.length > 0) {
      const removed = session.replayChunks.shift() ?? "";
      session.replayBytes -= Buffer.byteLength(removed);
    }
  }

  private sendReplay(session: TerminalSession): void {
    if (session.replayChunks.length > 0) {
      this.send(IpcChannels.terminalData, session.id, session.replayChunks.join(""));
    }
  }

  private killPty(session: TerminalSession): void {
    try {
      session.pty?.kill();
    } finally {
      session.pty = null;
    }
  }

  private send(channel: string, ...args: unknown[]): void {
    if (!this.window.isDestroyed()) this.window.webContents.send(channel, ...args);
  }

  private failSessionStart(session: TerminalSession, shell: ShellProfile, error: unknown): void {
    session.pty = null;
    const message = error instanceof Error ? error.message : String(error);
    const commandLine = [shell.command, ...shell.args].join(" ").trim();
    const output = `\r\n\x1b[31m[failed to start terminal]\x1b[0m ${commandLine}\r\n${message}\r\n`;
    this.appendReplay(session, output);
    this.send(IpcChannels.terminalData, session.id, output);
    this.send(IpcChannels.terminalExit, session.id, { exitCode: 1, signal: 0 });
  }

  private normalizeShell(profile: ShellProfile): ShellProfile {
    if (profile.args.length > 0 || !/\s/.test(profile.command) || fs.existsSync(profile.command)) return profile;
    const parts = this.splitCommandLine(profile.command);
    if (parts.length <= 1) return profile;
    return { ...profile, command: parts[0], args: [...parts.slice(1), ...profile.args] };
  }

  private splitCommandLine(value: string): string[] {
    const parts: string[] = [];
    let current = "";
    let quote: '"' | "'" | null = null;
    let escaping = false;

    for (const char of value.trim()) {
      if (escaping) {
        current += char;
        escaping = false;
        continue;
      }
      if (char === "\\") {
        escaping = true;
        continue;
      }
      if ((char === '"' || char === "'") && (!quote || quote === char)) {
        quote = quote ? null : char;
        continue;
      }
      if (/\s/.test(char) && !quote) {
        if (current) {
          parts.push(current);
          current = "";
        }
        continue;
      }
      current += char;
    }

    if (escaping) current += "\\";
    if (current) parts.push(current);
    return parts;
  }

  private resolveShell(profile: ShellProfile | null): ShellProfile {
    if (profile?.command) return profile;
    return defaultShellProfiles()[0] ?? {
      id: "system",
      name: "System shell",
      command: process.platform === "win32" ? "powershell.exe" : process.env.SHELL || "/bin/sh",
      args: process.platform === "win32" ? ["-NoLogo"] : ["-l"],
    };
  }
}
