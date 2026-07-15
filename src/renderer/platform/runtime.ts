/** Runtime selection is kept separate from the browser development fallback so
 * importing the renderer does not assume that the Tauri globals are present. */
export function isTauriRuntime(
  scope: Window | undefined = typeof window === "undefined" ? undefined : window,
): boolean {
  return Boolean(scope && "__TAURI_INTERNALS__" in scope);
}
