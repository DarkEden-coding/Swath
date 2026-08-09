import type { ImageRpcLoadSuccess, ImageRpcRequest } from "../../shared/ipc/imageRpc";
import { parseImageRpcLoadSuccess } from "../../shared/ipc/imageRpc";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Invokes the host image RPC surface. */
async function imageRpc(request: ImageRpcRequest): Promise<unknown> {
  return window.swath.image.rpc(request);
}

/**
 * Loads a local image under `cwd` via the host RPC.
 * Returns base64 bytes suitable for a CSP-safe `data:` URL; never persists image bytes.
 */
export async function loadImage(path: string, cwd: string): Promise<ImageRpcLoadSuccess> {
  const raw = await imageRpc({ op: "load", path, cwd });
  const success = parseImageRpcLoadSuccess(raw);
  if (success) return success;
  const error =
    isRecord(raw) && typeof raw.error === "string" && raw.error.trim()
      ? raw.error.trim()
      : "Unable to load image";
  throw new Error(error);
}

export const imageClient = {
  load: loadImage,
};
