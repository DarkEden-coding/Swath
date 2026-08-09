/** Renderer → host request to load a local image under a workspace cwd. */
export type ImageRpcRequest = { op: "load"; path: string; cwd: string };

/** Successful image_rpc load payload (bytes as base64 for CSP-safe data URLs). */
export interface ImageRpcLoadSuccess {
  ok: true;
  path: string;
  title: string;
  mimeType: string;
  dataBase64: string;
  byteLength: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  return typeof v === "string" ? v : null;
}

/** Validates renderer → main image payloads. */
export function parseImageRpcRequest(raw: unknown): ImageRpcRequest | null {
  if (!isRecord(raw)) return null;
  if (raw.op !== "load") return null;
  const path = stringField(raw, "path");
  const cwd = stringField(raw, "cwd");
  if (path === null || !path.trim() || cwd === null || !cwd.trim()) return null;
  return { op: "load", path: path.trim(), cwd: cwd.trim() };
}

/** Parses a successful image load response; returns null when shape is invalid. */
export function parseImageRpcLoadSuccess(raw: unknown): ImageRpcLoadSuccess | null {
  if (!isRecord(raw) || raw.ok !== true) return null;
  const path = stringField(raw, "path");
  const title = stringField(raw, "title");
  const mimeType = stringField(raw, "mimeType");
  const dataBase64 = stringField(raw, "dataBase64");
  const byteLength = raw.byteLength;
  if (
    path === null ||
    title === null ||
    mimeType === null ||
    dataBase64 === null ||
    typeof byteLength !== "number" ||
    !Number.isFinite(byteLength)
  ) {
    return null;
  }
  return {
    ok: true,
    path,
    title,
    mimeType,
    dataBase64,
    byteLength,
  };
}
