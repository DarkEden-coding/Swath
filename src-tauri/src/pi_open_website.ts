import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const STATUS_KEY = "swath:open-website";

/** Converts a local HTML file or supported web address into a navigable URL. */
export function websiteUrl(input: string, cwd: string): string {
  const value = input.trim();
  if (!value) throw new Error("Provide a local HTML file or an HTTP(S) URL.");
  if (
    value.startsWith("file://") ||
    isAbsolute(value) ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /\.html?$/i.test(value)
  ) {
    const file = value.startsWith("file://") ? fileURLToPath(value) : resolve(cwd, value);
    if (!/\.html?$/i.test(file) || !statSync(file).isFile()) {
      throw new Error("The local address must point to an existing HTML file.");
    }
    return pathToFileURL(file).href;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provide an existing HTML file or a complete HTTP(S) URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only HTML files and HTTP(S) addresses can open in Swath.");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("Non-local websites must use HTTPS.");
  }
  return url.href;
}

/** Offers an explicit, user-requested website tab to Pi agents embedded in Swath. */
export default function swathWebsiteTabs(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "swath_open_website",
    label: "Open Website in Swath",
    description:
      "Open a local HTML file, localhost site, or HTTPS website in a new embedded Swath tab. Use only when the user explicitly asks you to open a website in Swath. Never open tabs proactively.",
    parameters: Type.Object({
      address: Type.String({
        description: "An HTML file path, file URL, localhost URL, or HTTPS URL.",
      }),
      title: Type.Optional(Type.String({ description: "Optional tab title." })),
    }),
    async execute(toolCallId, params, _signal, _update, ctx) {
      if (process.env.SWATH_PI_AGENT !== "1" || ctx.mode !== "rpc") {
        throw new Error("Website tabs require a Pi agent embedded in Swath.");
      }
      const url = websiteUrl(params.address, ctx.cwd);
      await ctx.ui.setStatus(
        `${STATUS_KEY}:${toolCallId}`,
        JSON.stringify({ url, title: params.title }),
      );
      return {
        content: [{ type: "text", text: `Requested a Swath website tab for ${url}.` }],
        details: { url },
      };
    },
  });
}
