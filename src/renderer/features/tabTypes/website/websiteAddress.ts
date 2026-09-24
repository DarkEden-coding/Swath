/** Address accepted by the embedded website pane. */
export type WebsiteAddress = { url: string; title: string };

/**
 * Normalizes a user-supplied HTTPS/localhost URL or local HTML file path for an iframe.
 *
 * `file:` URLs are attempted only in native WebViews. Browser clients receive a fallback because
 * browsers deliberately block file origins from a remote Swath page.
 */
export function websiteAddressFrom(value: string): WebsiteAddress | null {
  const input = value.trim();
  if (!input) return null;
  const localPath = input.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(input);
  const candidate =
    /^https?:\/\//i.test(input) || /^file:/i.test(input)
      ? input
      : localPath
        ? `file:///${input.replace(/^\/+/, "").replace(/\\/g, "/")}`
        : /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(input)
          ? `http://${input}`
          : `https://${input}`;
  try {
    const url = new URL(candidate);
    const localHttp = url.protocol === "http:" && isLocalhost(url.hostname);
    const localHtml = url.protocol === "file:" && /\.html?$/i.test(url.pathname);
    if (url.protocol !== "https:" && !localHttp && !localHtml) return null;
    return { url: url.toString(), title: titleFor(url) };
  } catch {
    return null;
  }
}

/** True for loopback hosts, the only HTTP origins allowed by embedded website panes. */
function isLocalhost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/** Produces a short default tab title without trusting page-controlled document titles. */
function titleFor(url: URL): string {
  if (url.protocol === "file:") {
    const name = url.pathname.split("/").filter(Boolean).at(-1);
    return name ? decodeURIComponent(name) : "Local HTML";
  }
  return url.hostname + (url.pathname === "/" ? "" : url.pathname);
}
