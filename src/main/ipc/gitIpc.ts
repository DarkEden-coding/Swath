import { ipcMain } from "electron";
import { IpcChannels, parseGitRpcRequest, type GitRpcRequest } from "../../shared/ipc";
import { runGit } from "../services/gitRunner";

const RS = "\x1f";

function splitNullTerminated(stdout: string): string[] {
  if (!stdout) return [];
  return stdout.split("\0").filter((p) => p.length > 0);
}

interface PathStatusRow {
  path: string;
  status: string;
}

function parseNameStatus(stdout: string): PathStatusRow[] {
  const out: PathStatusRow[] = [];
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const tab = line.indexOf("\t");
    if (tab < 1) continue;
    const rawStatus = line.slice(0, tab);
    const pathField = line.slice(tab + 1);
    const letter = rawStatus[0] ?? "?";
    const path = pathField.includes("\t") ? pathField.split("\t").pop() ?? pathField : pathField;
    out.push({ path, status: letter });
  }
  return out;
}

async function gitGetStatus(cwd: string): Promise<unknown> {
  const root = cwd.trim();
  const wt = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (wt.exitCode !== 0 || wt.stdout.trim() !== "true") {
    return {
      ok: false,
      branch: null,
      staged: [],
      unstaged: [],
      untracked: [],
      error: wt.stderr.trim() || "Not a Git repository",
      stderr: wt.stderr
    };
  }
  const branchR = await runGit(root, ["branch", "--show-current"]);
  const branch = branchR.exitCode === 0 ? branchR.stdout.trim() || null : null;
  const [unstagedR, stagedR, untrackedR] = await Promise.all([
    runGit(root, ["diff", "--name-status"]),
    runGit(root, ["diff", "--cached", "--name-status"]),
    runGit(root, ["ls-files", "-z", "--others", "--exclude-standard"])
  ]);
  const unstaged = parseNameStatus(unstagedR.stdout);
  const staged = parseNameStatus(stagedR.stdout);
  const untracked = splitNullTerminated(untrackedR.stdout);
  return {
    ok: true,
    branch,
    staged,
    unstaged,
    untracked,
    stderr: [unstagedR.stderr, stagedR.stderr, untrackedR.stderr].filter(Boolean).join("\n")
  };
}

async function gitStagePaths(cwd: string, paths: string[]): Promise<unknown> {
  if (paths.length === 0) return { exitCode: 0, stdout: "", stderr: "" };
  return runGit(cwd.trim(), ["add", "--", ...paths]);
}

async function gitUnstagePaths(cwd: string, paths: string[]): Promise<unknown> {
  if (paths.length === 0) return { exitCode: 0, stdout: "", stderr: "" };
  return runGit(cwd.trim(), ["restore", "--staged", "--", ...paths]);
}

async function gitDiscardPaths(cwd: string, paths: string[]): Promise<unknown> {
  if (paths.length === 0) return { exitCode: 0, stdout: "", stderr: "" };
  const root = cwd.trim();
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const p of paths) {
    const r = await runGit(root, ["ls-files", "--error-unmatch", "--", p]);
    if (r.exitCode === 0) tracked.push(p);
    else untracked.push(p);
  }
  const stderr: string[] = [];
  const stdout: string[] = [];
  let exitCode = 0;
  if (untracked.length > 0) {
    const c = await runGit(root, ["clean", "-f", "-q", "--", ...untracked]);
    stdout.push(c.stdout);
    stderr.push(c.stderr);
    if (c.exitCode !== 0) exitCode = c.exitCode;
  }
  if (tracked.length > 0 && exitCode === 0) {
    const re = await runGit(root, ["restore", "--worktree", "--", ...tracked]);
    stdout.push(re.stdout);
    stderr.push(re.stderr);
    exitCode = re.exitCode;
  }
  return { exitCode, stdout: stdout.join("\n"), stderr: stderr.filter(Boolean).join("\n") };
}

async function gitCommit(cwd: string, message: string): Promise<unknown> {
  const trimmed = message.trim();
  if (!trimmed) return { exitCode: 1, stdout: "", stderr: "Commit message is required" };
  return runGit(cwd.trim(), ["commit", "-m", trimmed]);
}

async function gitSync(cwd: string): Promise<unknown> {
  const root = cwd.trim();
  const pull = await runGit(root, ["pull"]);
  if (pull.exitCode !== 0) {
    return { ok: false, exitCode: pull.exitCode, stdout: pull.stdout, stderr: pull.stderr, steps: ["pull"] };
  }
  const push = await runGit(root, ["push"]);
  return {
    ok: push.exitCode === 0,
    exitCode: push.exitCode,
    stdout: [pull.stdout, push.stdout].join("\n---\n"),
    stderr: [pull.stderr, push.stderr].filter(Boolean).join("\n"),
    steps: ["pull", "push"]
  };
}

interface GitLogCommitRow {
  graph: string;
  hash: string;
  parents: string[];
  short: string;
  subject: string;
  author: string;
  date: string;
  refs: string;
}

async function gitGetLog(cwd: string): Promise<unknown> {
  const root = cwd.trim();
  const wt = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (wt.exitCode !== 0 || wt.stdout.trim() !== "true") {
    return { ok: false, commits: [], error: wt.stderr.trim() || "Not a Git repository" };
  }
  const empty = await runGit(root, ["rev-parse", "-q", "--verify", "HEAD"]);
  if (empty.exitCode !== 0) {
    return { ok: true, commits: [] };
  }
  const logR = await runGit(root, [
    "-c",
    "core.quotepath=false",
    "log",
    "--all",
    "--graph",
    "--color=never",
    "-n",
    "100",
    "--date=relative",
    `--pretty=format:%H${RS}%P${RS}%h${RS}%s${RS}%an${RS}%cr${RS}%D`
  ]);
  if (logR.exitCode !== 0) {
    return { ok: false, commits: [], error: logR.stderr.trim() || "git log failed", stderr: logR.stderr };
  }
  const commits: GitLogCommitRow[] = [];
  for (const line of logR.stdout.split("\n")) {
    if (!line.trim()) continue;
    const m = line.match(/([0-9a-f]{40})/);
    if (!m || m.index === undefined) continue;
    const graph = line.slice(0, m.index).replace(/\s+$/, "");
    const tail = line.slice(m.index);
    const parts = tail.split(RS);
    if (parts.length < 7) continue;
    const [hash, parentsStr, short, subject, author, date, refs] = parts;
    if (!hash || hash.length < 40) continue;
    const parents = (parentsStr ?? "")
      .trim()
      .split(/\s+/)
      .filter((p) => /^[0-9a-f]{40}$/i.test(p));
    commits.push({
      graph,
      hash,
      parents,
      short: short ?? hash.slice(0, 7),
      subject: subject ?? "",
      author: author ?? "",
      date: date ?? "",
      refs: refs ?? ""
    });
  }
  return { ok: true, commits };
}

async function gitListBranches(cwd: string): Promise<unknown> {
  const root = cwd.trim();
  const r = await runGit(root, ["branch", "-a", "--format=%(refname:short)"]);
  if (r.exitCode !== 0) {
    return { ok: false, branches: [], error: r.stderr.trim() || "Unable to list branches" };
  }
  const seen = new Set<string>();
  const branches: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const b = line.trim();
    if (!b || b === "HEAD" || seen.has(b)) continue;
    seen.add(b);
    branches.push(b);
  }
  branches.sort((a, x) => a.localeCompare(x, undefined, { sensitivity: "base" }));
  return { ok: true, branches };
}

async function gitCheckoutBranch(cwd: string, branch: string): Promise<unknown> {
  return runGit(cwd.trim(), ["switch", branch]);
}

async function handleGitRpc(req: GitRpcRequest): Promise<unknown> {
  switch (req.op) {
    case "getStatus":
      return gitGetStatus(req.cwd);
    case "stagePaths":
      return gitStagePaths(req.cwd, req.paths);
    case "unstagePaths":
      return gitUnstagePaths(req.cwd, req.paths);
    case "discardPaths":
      return gitDiscardPaths(req.cwd, req.paths);
    case "commit":
      return gitCommit(req.cwd, req.message);
    case "pull":
      return runGit(req.cwd.trim(), ["pull"]);
    case "push":
      return runGit(req.cwd.trim(), ["push"]);
    case "sync":
      return gitSync(req.cwd);
    case "getLog":
      return gitGetLog(req.cwd);
    case "listBranches":
      return gitListBranches(req.cwd);
    case "checkoutBranch":
      return gitCheckoutBranch(req.cwd, req.branch);
    default:
      return { exitCode: 1, stdout: "", stderr: "Unknown git operation" };
  }
}

export function registerGitIpc(): void {
  ipcMain.handle(IpcChannels.gitRpc, async (_event, raw: unknown) => {
    const req = parseGitRpcRequest(raw);
    if (!req) return { ok: false, error: "Invalid git request", exitCode: 1, stdout: "", stderr: "Invalid git request" };
    return handleGitRpc(req);
  });
}
