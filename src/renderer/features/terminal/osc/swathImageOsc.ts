import { SWATH_IMAGE_OSC_MAX_CHARS } from "../../../../shared/memoryLimits";

const SWATH_IMAGE_PREFIX = "swath-image=";

export type SwathImageOscParseResult =
  { kind: "ignore" } | { kind: "invalid" } | { kind: "path"; path: string };

/** Decodes standard base64 into a UTF-8 string without throwing on large inputs. */
function decodeBase64Utf8(encoded: string): string | null {
  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Parses OSC 777 payload data for `swath-image=<base64 UTF-8 path>`.
 * Matching but malformed payloads return `invalid` so callers can consume them.
 */
export function parseSwathImageOsc(data: string): SwathImageOscParseResult {
  if (!data.startsWith(SWATH_IMAGE_PREFIX)) return { kind: "ignore" };
  const encoded = data.slice(SWATH_IMAGE_PREFIX.length).trim();
  if (!encoded || encoded.length > SWATH_IMAGE_OSC_MAX_CHARS) return { kind: "invalid" };
  if (!/^[A-Za-z0-9+/]+=*$/.test(encoded)) return { kind: "invalid" };
  const path = decodeBase64Utf8(encoded)?.trim() ?? "";
  if (!path) return { kind: "invalid" };
  return { kind: "path", path };
}
