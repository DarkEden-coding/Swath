import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GIT_RUN_MAX_BUFFER_BYTES } from "../../shared/memoryLimits";

const execFileAsync = promisify(execFile);

export interface RunGitOptions {
  /** Max time before SIGTERM (ms). */
  timeout?: number;
  maxBuffer?: number;
}

export interface RunGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `git` with argv in `cwd`. Uses execFile (no shell) for predictable parsing.
 */
export async function runGit(cwd: string, args: string[], options?: RunGitOptions): Promise<RunGitResult> {
  const timeout = options?.timeout ?? 300_000;
  const maxBuffer = options?.maxBuffer ?? GIT_RUN_MAX_BUFFER_BYTES;
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer,
      timeout,
      windowsHide: true
    });
    return { exitCode: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (err: unknown) {
    const e = err as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: string | number;
      status?: number;
      message?: string;
    };
    const exitCode = typeof e.status === "number" ? e.status : e.code === "ENOENT" ? 127 : 1;
    const out = typeof e.stdout === "string" ? e.stdout : e.stdout ? e.stdout.toString() : "";
    const errOut = typeof e.stderr === "string" ? e.stderr : e.stderr ? e.stderr.toString() : "";
    return {
      exitCode,
      stdout: out,
      stderr: errOut || e.message || ""
    };
  }
}
