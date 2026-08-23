/** Runtime selection is kept separate from the browser development fallback so
 * importing the renderer does not assume that the Tauri globals are present. */
export function isTauriRuntime(
  scope: Window | undefined = typeof window === "undefined" ? undefined : window,
): boolean {
  return Boolean(scope && "__TAURI_INTERNALS__" in scope);
}

type NavigatorLike = Pick<Navigator, "platform" | "userAgent">;

/** Maps the host OS to the Node-style platform id used by `window.swath.platform`. */
export function detectHostPlatform(
  navigatorLike: NavigatorLike | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator,
): string {
  const platform = navigatorLike?.platform ?? "";
  const userAgent = navigatorLike?.userAgent ?? "";
  if (/Win/i.test(platform) || /Windows/i.test(userAgent)) return "win32";
  if (/Mac/i.test(platform) || /Mac OS|Macintosh/i.test(userAgent)) return "darwin";
  if (/Linux/i.test(platform) || /Linux/i.test(userAgent)) return "linux";
  return "linux";
}
