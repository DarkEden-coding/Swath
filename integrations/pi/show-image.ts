/**
 * Swath image preview extension for pi coding-agent 0.82.1.
 *
 * Registers `show_image` (LLM tool) and `/preview` (slash command). Both resolve a
 * local raster image path and emit OSC 777 `swath-image=<base64 UTF-8 absolute path>`
 * so Swath can open an `imagePreview` pane. Does not emit inline graphics (IIP/SIXEL).
 */

import { open, lstat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** Maximum accepted image file size (matches Swath `IMAGE_MAX_BYTES` / 10 MiB). */
const IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** Bytes needed to distinguish PNG / JPEG / GIF / WebP magic headers. */
const MAGIC_HEADER_BYTES = 12;

/** Allowed MIME labels returned after magic-byte detection. */
type ImageMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

/** Successful preview emission result. */
type PreviewSuccess = {
  path: string;
  mime: ImageMime;
  bytes: number;
};

/** Tool / command parameter schema for a filesystem image path. */
const ShowImageParams = Type.Object({
  path: Type.String({
    description:
      "Path to a PNG, JPEG, GIF, or WebP file. Relative paths resolve against the session cwd. A single leading @ is stripped.",
  }),
});

/**
 * Strips at most one leading `@` that some models prepend to path arguments.
 */
function stripLeadingAt(rawPath: string): string {
  return rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
}

/**
 * Resolves `rawPath` to an absolute path using `cwd` for relative inputs.
 */
function resolveImagePath(cwd: string, rawPath: string): string {
  const trimmed = stripLeadingAt(rawPath.trim());
  if (!trimmed) {
    throw new Error("Image path is empty");
  }
  return isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed);
}

/**
 * Returns a MIME type when `header` matches an allowed raster format; otherwise null.
 * SVG and other formats are rejected (no XML sniffing path).
 */
function detectImageMime(header: Uint8Array): ImageMime | null {
  if (
    header.length >= 8 &&
    header[0] === 0x89 &&
    header[1] === 0x50 &&
    header[2] === 0x4e &&
    header[3] === 0x47 &&
    header[4] === 0x0d &&
    header[5] === 0x0a &&
    header[6] === 0x1a &&
    header[7] === 0x0a
  ) {
    return "image/png";
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  if (header.length >= 6) {
    const gif = String.fromCharCode(...header.subarray(0, 6));
    if (gif === "GIF87a" || gif === "GIF89a") {
      return "image/gif";
    }
  }
  if (
    header.length >= 12 &&
    header[0] === 0x52 &&
    header[1] === 0x49 &&
    header[2] === 0x46 &&
    header[3] === 0x46 &&
    header[8] === 0x57 &&
    header[9] === 0x45 &&
    header[10] === 0x42 &&
    header[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Validates that `absolutePath` is a readable regular file of an allowed type and size,
 * then emits OSC 777 for Swath. Never writes image pixel data to the terminal.
 */
async function emitSwathImagePreview(absolutePath: string): Promise<PreviewSuccess> {
  const meta = await lstat(absolutePath);
  if (!meta.isFile() || meta.isSymbolicLink()) {
    throw new Error("Path is not a regular file (directories and symlinks are rejected)");
  }
  if (meta.size > IMAGE_MAX_BYTES) {
    throw new Error(`Image exceeds ${IMAGE_MAX_BYTES} byte limit`);
  }
  if (meta.size === 0) {
    throw new Error("Image file is empty");
  }

  let mime: ImageMime;
  const handle = await open(absolutePath, "r");
  try {
    const header = new Uint8Array(MAGIC_HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, MAGIC_HEADER_BYTES, 0);
    const detected = detectImageMime(header.subarray(0, bytesRead));
    if (!detected) {
      throw new Error("Unsupported image type (allowed: PNG, JPEG, GIF, WebP)");
    }
    mime = detected;
  } finally {
    await handle.close();
  }

  const encoded = Buffer.from(absolutePath, "utf8").toString("base64");
  process.stdout.write(`\x1b]777;swath-image=${encoded}\x07`);

  return { path: absolutePath, mime, bytes: meta.size };
}

/**
 * Shared path → OSC preview flow used by the tool and `/preview` command.
 */
async function previewImageFromPath(cwd: string, rawPath: string): Promise<PreviewSuccess> {
  const absolutePath = resolveImagePath(cwd, rawPath);
  return emitSwathImagePreview(absolutePath);
}

/**
 * Formats a concise success message for the LLM / UI.
 */
function successText(result: PreviewSuccess): string {
  return `Previewed ${result.path} (${result.mime}, ${result.bytes} bytes)`;
}

/**
 * Pi extension entry: registers `show_image` and `/preview`.
 */
export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "show_image",
    label: "Show Image",
    description:
      "Open a local PNG/JPEG/GIF/WebP image in the Swath imagePreview pane via OSC 777. Does not render inline terminal graphics.",
    promptSnippet: "Open a local image in Swath's preview pane",
    promptGuidelines: [
      "Use show_image when the user asks to preview or open a local image file in Swath.",
      "Pass a filesystem path to show_image; do not embed image bytes in the terminal.",
    ],
    parameters: ShowImageParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await previewImageFromPath(ctx.cwd, params.path);
      return {
        content: [{ type: "text" as const, text: successText(result) }],
        details: result,
      };
    },
  });

  pi.registerCommand("preview", {
    description: "Open a local image in Swath's imagePreview pane (PNG/JPEG/GIF/WebP)",
    handler: async (args, ctx) => {
      const rawPath = args.trim();
      if (!rawPath) {
        ctx.ui.notify("Usage: /preview <path>", "warning");
        return;
      }
      try {
        const result = await previewImageFromPath(ctx.cwd, rawPath);
        ctx.ui.notify(successText(result), "info");
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
      }
    },
  });
}
