export type GitRpcRequest =
  | { op: "getStatus"; cwd: string }
  | { op: "stagePaths"; cwd: string; paths: string[] }
  | { op: "unstagePaths"; cwd: string; paths: string[] }
  | { op: "discardPaths"; cwd: string; paths: string[] }
  | { op: "commit"; cwd: string; message: string; runId?: string }
  | { op: "pull"; cwd: string; runId?: string }
  | { op: "push"; cwd: string; runId?: string }
  | { op: "sync"; cwd: string; runId?: string }
  | { op: "getLog"; cwd: string }
  | { op: "listBranches"; cwd: string }
  | { op: "checkoutBranch"; cwd: string; branch: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

function stringArrayField(obj: Record<string, unknown>, key: string): string[] | null {
  const v = obj[key];
  if (!Array.isArray(v)) return null;
  const out = v.filter((item): item is string => typeof item === "string");
  return out.length === v.length ? out : null;
}

/** Validates renderer → main git payloads. */
export function parseGitRpcRequest(raw: unknown): GitRpcRequest | null {
  if (!isRecord(raw)) return null;
  const op = raw.op;
  if (op === "getStatus") {
    const cwd = stringField(raw, "cwd");
    return cwd !== null && cwd.trim() ? { op: "getStatus", cwd: cwd.trim() } : null;
  }
  if (op === "stagePaths" || op === "unstagePaths" || op === "discardPaths") {
    const cwd = stringField(raw, "cwd");
    const paths = stringArrayField(raw, "paths");
    if (!cwd?.trim() || paths === null) return null;
    return { op, cwd: cwd.trim(), paths };
  }
  if (op === "commit") {
    const cwd = stringField(raw, "cwd");
    const message = stringField(raw, "message");
    if (!cwd?.trim() || message === null) return null;
    const runId = stringField(raw, "runId");
    return {
      op: "commit",
      cwd: cwd.trim(),
      message,
      ...(runId?.trim() ? { runId: runId.trim() } : {}),
    };
  }
  if (op === "pull" || op === "push" || op === "sync") {
    const cwd = stringField(raw, "cwd");
    if (cwd === null || !cwd.trim()) return null;
    const runId = stringField(raw, "runId");
    return {
      op,
      cwd: cwd.trim(),
      ...(runId?.trim() ? { runId: runId.trim() } : {}),
    };
  }
  if (op === "getLog" || op === "listBranches") {
    const cwd = stringField(raw, "cwd");
    return cwd !== null && cwd.trim() ? { op, cwd: cwd.trim() } : null;
  }
  if (op === "checkoutBranch") {
    const cwd = stringField(raw, "cwd");
    const branch = stringField(raw, "branch");
    if (!cwd?.trim() || branch === null || !branch.trim()) return null;
    return { op: "checkoutBranch", cwd: cwd.trim(), branch: branch.trim() };
  }
  return null;
}
