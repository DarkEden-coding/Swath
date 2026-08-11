/**
 * Path helpers for the file browser. Paths are `/`-separated and relative to the
 * pane cwd; the empty string is the workspace root.
 */

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp"]);

/** Joins a parent directory and a leaf name into a relative path. */
export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Returns the containing directory of `path`, or the root for top-level entries. */
export function parentPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/** Returns the leaf name of `path`. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** True when `path` is `ancestor` itself or lives beneath it. */
export function isWithin(ancestor: string, path: string): boolean {
  if (!ancestor) return true;
  return path === ancestor || path.startsWith(`${ancestor}/`);
}

/**
 * True when `source` may be dropped into directory `targetDir`: a move into its
 * own current parent is a no-op, and a directory cannot swallow itself.
 */
export function canDropInto(source: string, targetDir: string): boolean {
  if (!source) return false;
  if (isWithin(source, targetDir)) return false;
  return parentPath(source) !== targetDir;
}

/** Rejects names that would traverse directories or produce an empty leaf. */
export function isValidName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed !== "" && trimmed !== "." && trimmed !== ".." && !/[/\\]/.test(trimmed);
}

/** True when the file can be shown in the image preview tab. */
export function isImagePath(path: string): boolean {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 && IMAGE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}
