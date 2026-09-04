import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PASSWORD_TITLE = "SWATH_SUDO_PASSWORD_V1:Administrator password required";
const TEN_MINUTES = 10 * 60 * 1000;

/** Runs a sudo credential check without exposing the password in argv or the environment. */
function checkSudo(
  cwd: string,
  password: string,
  signal: AbortSignal | undefined,
): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn("sudo", ["-S", "-p", "", "-v"], {
      cwd,
      stdio: ["pipe", "ignore", "ignore"],
    });
    const abort = (): void => child.kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => resolve(false));
    child.stdin.on("error", () => resolve(false));
    child.once("close", (code) => {
      signal?.removeEventListener("abort", abort);
      resolve(code === 0);
    });
    child.stdin.end(`${password}\n`);
  });
}

/** Stores the password in a user-only temporary directory and returns its paths. */
function createAskpass(password: string): { dir: string; helper: string; secret: string } {
  const dir = mkdtempSync(join(tmpdir(), "swath-sudo-"));
  chmodSync(dir, 0o700);
  const secret = join(dir, "password");
  const helper = join(dir, "askpass");
  writeFileSync(secret, password, { mode: 0o600 });
  writeFileSync(helper, `#!/bin/sh\ncat "${secret}"\n`, { mode: 0o700 });
  return { dir, helper, secret };
}

/** Reports whether sudo runs through ssh rather than on this machine. */
export function usesRemoteSudo(command: string): boolean {
  return /(^|[^\w])ssh\b[^\n]*\bsudo(?:\s|$)/m.test(command);
}

/** Pipes the password to remote sudo's standard input without putting it in the command text. */
export function useRemotePassword(command: string, secret: string): string {
  const rewritten = command.replace(/(^|[^\w])sudo(?:\s+-n\b)?/gm, "$1sudo -k -S");
  return rewritten.replace(
    /(^|[;&|]\s*)ssh\b(?=[^\n]*\bsudo(?:\s|$))/m,
    `$1cat ${JSON.stringify(secret)} | ssh`,
  );
}

/** Makes every local sudo invocation use Swath's askpass helper, including commands written with `-n`. */
function useAskpass(command: string, helper: string): string {
  const rewritten = command.replace(/(^|[^\w])sudo(?:\s+-n\b)?/gm, "$1sudo -A");
  return `export SUDO_ASKPASS=${JSON.stringify(helper)}; ${rewritten}`;
}

/** Adds password prompting to sudo calls made by Pi's built-in bash tool. */
export default function sudoPrompt(pi: ExtensionAPI): void {
  let credentials: { dir: string; helper: string; secret: string } | undefined;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  const remoteCredentialDirs = new Set<string>();

  const clearCredentials = (): void => {
    if (credentials) rmSync(credentials.dir, { recursive: true, force: true });
    for (const dir of remoteCredentialDirs) rmSync(dir, { recursive: true, force: true });
    remoteCredentialDirs.clear();
    credentials = undefined;
    clearTimeout(expiryTimer);
  };

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { command?: unknown };
    if (typeof input.command !== "string" || !/(^|[^\w])sudo(?:\s|$)/m.test(input.command)) {
      return;
    }

    if (usesRemoteSudo(input.command)) {
      const password = await ctx.ui.input(PASSWORD_TITLE, "Remote sudo password");
      if (password === undefined) {
        return { block: true, reason: "Sudo password entry was cancelled" };
      }
      const remoteCredentials = createAskpass(password);
      remoteCredentialDirs.add(remoteCredentials.dir);
      setTimeout(() => {
        rmSync(remoteCredentials.dir, { recursive: true, force: true });
        remoteCredentialDirs.delete(remoteCredentials.dir);
      }, TEN_MINUTES);
      input.command = useRemotePassword(input.command, remoteCredentials.secret);
      return;
    }

    if (!credentials) {
      const password = await ctx.ui.input(PASSWORD_TITLE, "Password");
      if (password === undefined) {
        return { block: true, reason: "Sudo password entry was cancelled" };
      }
      if (!(await checkSudo(ctx.cwd, password, ctx.signal))) {
        return { block: true, reason: "Incorrect sudo password" };
      }
      credentials = createAskpass(password);
      expiryTimer = setTimeout(clearCredentials, TEN_MINUTES);
    }

    input.command = useAskpass(input.command, credentials.helper);
  });

  pi.on("session_shutdown", clearCredentials);
}
