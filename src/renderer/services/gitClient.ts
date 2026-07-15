import type { GitRpcRequest } from "../../shared/ipc";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export interface GitPathEntry {
  path: string;
  status: string;
}

export interface GitStatusResult {
  ok: boolean;
  branch: string | null;
  staged: GitPathEntry[];
  unstaged: GitPathEntry[];
  untracked: string[];
  error?: string;
  stderr?: string;
}

export interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitLogEntry {
  graph: string;
  hash: string;
  parents: string[];
  short: string;
  subject: string;
  author: string;
  date: string;
  refs: string;
}

export interface GitLogResult {
  ok: boolean;
  commits: GitLogEntry[];
  error?: string;
  stderr?: string;
}

export interface GitStreamOptions {
  runId?: string;
}

function parsePathEntries(raw: unknown): GitPathEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: GitPathEntry[] = [];
  for (const item of raw) {
    if (typeof item === "string") {
      out.push({ path: item, status: "M" });
      continue;
    }
    if (!isRecord(item)) continue;
    const path = typeof item.path === "string" ? item.path : null;
    const status = typeof item.status === "string" ? item.status : "?";
    if (path) out.push({ path, status });
  }
  return out;
}

function parseStatus(raw: unknown): GitStatusResult {
  if (!isRecord(raw)) {
    return {
      ok: false,
      branch: null,
      staged: [],
      unstaged: [],
      untracked: [],
      error: "Invalid response",
    };
  }
  const ok = raw.ok === true;
  const branch =
    typeof raw.branch === "string" || raw.branch === null ? (raw.branch as string | null) : null;
  const untrackedRaw = raw.untracked;
  const untracked: string[] = Array.isArray(untrackedRaw)
    ? untrackedRaw.filter((p): p is string => typeof p === "string")
    : [];
  return {
    ok,
    branch,
    staged: parsePathEntries(raw.staged),
    unstaged: parsePathEntries(raw.unstaged),
    untracked,
    error: typeof raw.error === "string" ? raw.error : undefined,
    stderr: typeof raw.stderr === "string" ? raw.stderr : undefined,
  };
}

function parseRun(raw: unknown): GitRunResult {
  if (!isRecord(raw)) return { exitCode: 1, stdout: "", stderr: "Invalid response" };
  const exitCode = typeof raw.exitCode === "number" ? raw.exitCode : 1;
  const stdout = typeof raw.stdout === "string" ? raw.stdout : "";
  const stderr = typeof raw.stderr === "string" ? raw.stderr : "";
  return { exitCode, stdout, stderr };
}

function parseLog(raw: unknown): GitLogResult {
  if (!isRecord(raw)) return { ok: false, commits: [], error: "Invalid response" };
  const ok = raw.ok === true;
  const commitsRaw = raw.commits;
  const commits: GitLogEntry[] = [];
  if (Array.isArray(commitsRaw)) {
    for (const row of commitsRaw) {
      if (!isRecord(row)) continue;
      const graph = typeof row.graph === "string" ? row.graph : "";
      const hash = typeof row.hash === "string" ? row.hash : "";
      if (!hash) continue;
      const parentsRaw = row.parents;
      const parents = Array.isArray(parentsRaw)
        ? parentsRaw.filter((p): p is string => typeof p === "string" && /^[0-9a-f]{40}$/i.test(p))
        : [];
      commits.push({
        graph,
        hash,
        parents,
        short: typeof row.short === "string" ? row.short : hash.slice(0, 7),
        subject: typeof row.subject === "string" ? row.subject : "",
        author: typeof row.author === "string" ? row.author : "",
        date: typeof row.date === "string" ? row.date : "",
        refs: typeof row.refs === "string" ? row.refs : "",
      });
    }
  }
  return {
    ok,
    commits,
    error: typeof raw.error === "string" ? raw.error : undefined,
    stderr: typeof raw.stderr === "string" ? raw.stderr : undefined,
  };
}

function parseBranches(raw: unknown): { ok: boolean; branches: string[]; error?: string } {
  if (!isRecord(raw)) return { ok: false, branches: [], error: "Invalid response" };
  const list = raw.branches;
  const branches = Array.isArray(list)
    ? list.filter((b): b is string => typeof b === "string")
    : [];
  return {
    ok: raw.ok === true,
    branches,
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

async function gitRpc(request: GitRpcRequest): Promise<unknown> {
  return window.swath.git.rpc(request);
}

function withRunId<T extends GitRpcRequest>(base: T, options?: GitStreamOptions): T {
  const runId = options?.runId?.trim();
  return runId ? { ...base, runId } : base;
}

export const gitClient = {
  getStatus(cwd: string): Promise<GitStatusResult> {
    return gitRpc({ op: "getStatus", cwd }).then(parseStatus);
  },
  stagePaths(cwd: string, paths: string[]): Promise<GitRunResult> {
    return gitRpc({ op: "stagePaths", cwd, paths }).then(parseRun);
  },
  unstagePaths(cwd: string, paths: string[]): Promise<GitRunResult> {
    return gitRpc({ op: "unstagePaths", cwd, paths }).then(parseRun);
  },
  discardPaths(cwd: string, paths: string[]): Promise<GitRunResult> {
    return gitRpc({ op: "discardPaths", cwd, paths }).then(parseRun);
  },
  commit(cwd: string, message: string, options?: GitStreamOptions): Promise<GitRunResult> {
    return gitRpc(withRunId({ op: "commit", cwd, message }, options)).then(parseRun);
  },
  pull(cwd: string, options?: GitStreamOptions): Promise<GitRunResult> {
    return gitRpc(withRunId({ op: "pull", cwd }, options)).then(parseRun);
  },
  push(cwd: string, options?: GitStreamOptions): Promise<GitRunResult> {
    return gitRpc(withRunId({ op: "push", cwd }, options)).then(parseRun);
  },
  sync(cwd: string, options?: GitStreamOptions): Promise<GitRunResult & { steps?: string[] }> {
    return gitRpc(withRunId({ op: "sync", cwd }, options)).then((raw) => {
      const base = parseRun(raw);
      const steps =
        isRecord(raw) && Array.isArray(raw.steps)
          ? raw.steps.filter((s): s is string => typeof s === "string")
          : undefined;
      return { ...base, steps };
    });
  },
  getLog(cwd: string): Promise<GitLogResult> {
    return gitRpc({ op: "getLog", cwd }).then(parseLog);
  },
  listBranches(cwd: string): Promise<{ ok: boolean; branches: string[]; error?: string }> {
    return gitRpc({ op: "listBranches", cwd }).then(parseBranches);
  },
  checkoutBranch(cwd: string, branch: string): Promise<GitRunResult> {
    return gitRpc({ op: "checkoutBranch", cwd, branch }).then(parseRun);
  },
  onData(callback: (runId: string, data: string) => void): () => void {
    return window.swath.git.onData(callback);
  },
};
