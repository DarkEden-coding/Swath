import type { PiIncoming } from "../../../../shared/ipc/piRpc";

const WEBSITE_STATUS_KEY = "swath:open-website";

/** The private Pi extension signal that requests a website tab in the current workspace. */
export interface WebsiteTabRequest {
  url: string;
  title?: string;
}

/**
 * Parses a completed `swath_open_website` extension signal.
 *
 * Expected extension payload: `ctx.ui.setStatus("swath:open-website", JSON.stringify({ url,
 * title? }))`. Only this status key opens a tab; clearing the status has no effect.
 */
export function websiteTabRequestFrom(event: PiIncoming): WebsiteTabRequest | null {
  if (
    event.type !== "extension_ui_request" ||
    event.method !== "setStatus" ||
    !event.statusKey?.startsWith(`${WEBSITE_STATUS_KEY}:`) ||
    !event.statusText
  ) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(event.statusText);
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { url?: unknown }).url !== "string" ||
      !(value as { url: string }).url.trim()
    ) {
      return null;
    }
    const request = value as Record<string, unknown>;
    return {
      url: request.url as string,
      ...(typeof request.title === "string" && request.title.trim()
        ? { title: request.title }
        : {}),
    };
  } catch {
    return null;
  }
}
