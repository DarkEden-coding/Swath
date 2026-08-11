/**
 * Batch image loading for `ask_user_questions` prompts.
 *
 * Questions may attach reference images; the dialog resolves every path for a question set
 * in one host round-trip. Individual paths can fail without failing the batch.
 */

/** Renderer → host request to load attached question images. */
export interface AskImagesRequest {
  paths: string[];
  cwd: string;
}

/** A successfully decoded image, ready to drop into an `<img src>`. */
export interface AskImageLoaded {
  path: string;
  title: string;
  dataUrl: string;
  byteLength: number;
}

/** A path that could not be loaded; surfaced in place of the tile. */
export interface AskImageFailed {
  path: string;
  error: string;
}

export type AskImage = AskImageLoaded | AskImageFailed;

export function isLoadedAskImage(image: AskImage): image is AskImageLoaded {
  return "dataUrl" in image;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringField(obj: Record<string, unknown>, key: string): string | null {
  const value = obj[key];
  return typeof value === "string" ? value : null;
}

/** Validates a renderer → host request; returns null when the shape is unusable. */
export function parseAskImagesRequest(raw: unknown): AskImagesRequest | null {
  if (!isRecord(raw)) return null;
  const cwd = stringField(raw, "cwd");
  if (cwd === null || !cwd.trim()) return null;
  if (!Array.isArray(raw.paths)) return null;
  const paths = raw.paths.filter((entry): entry is string => typeof entry === "string");
  if (paths.length !== raw.paths.length) return null;
  return { paths, cwd: cwd.trim() };
}

/** Parses a host response, dropping entries that match neither the loaded nor failed shape. */
export function parseAskImagesResponse(raw: unknown): AskImage[] | null {
  if (!isRecord(raw) || !Array.isArray(raw.images)) return null;
  const images: AskImage[] = [];
  for (const entry of raw.images) {
    if (!isRecord(entry)) continue;
    const path = stringField(entry, "path");
    if (path === null) continue;
    const error = stringField(entry, "error");
    if (error !== null) {
      images.push({ path, error });
      continue;
    }
    const title = stringField(entry, "title");
    const dataUrl = stringField(entry, "dataUrl");
    const byteLength = entry.byteLength;
    if (title === null || dataUrl === null || typeof byteLength !== "number") continue;
    images.push({ path, title, dataUrl, byteLength });
  }
  return images;
}
