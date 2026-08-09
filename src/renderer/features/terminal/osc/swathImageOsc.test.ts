import { describe, expect, it } from "vitest";
import { parseSwathImageOsc } from "./swathImageOsc";
import { SWATH_IMAGE_OSC_MAX_CHARS } from "../../../../shared/memoryLimits";

/** Encodes a UTF-8 path the same way as terminal drag/drop input. */
function encodePath(path: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(path)));
}

describe("parseSwathImageOsc", () => {
  it("ignores unrelated OSC payloads", () => {
    expect(parseSwathImageOsc("other=1")).toEqual({ kind: "ignore" });
    expect(parseSwathImageOsc("")).toEqual({ kind: "ignore" });
  });

  it("decodes a valid base64 UTF-8 path", () => {
    const path = "/Users/me/project/shot.png";
    expect(parseSwathImageOsc(`swath-image=${encodePath(path)}`)).toEqual({
      kind: "path",
      path,
    });
  });

  it("consumes malformed matching requests as invalid", () => {
    expect(parseSwathImageOsc("swath-image=")).toEqual({ kind: "invalid" });
    expect(parseSwathImageOsc("swath-image=!!!")).toEqual({ kind: "invalid" });
    expect(parseSwathImageOsc("swath-image=not%%base64")).toEqual({ kind: "invalid" });
  });

  it("rejects oversized matching payloads", () => {
    const huge = "A".repeat(SWATH_IMAGE_OSC_MAX_CHARS + 1);
    expect(parseSwathImageOsc(`swath-image=${huge}`)).toEqual({ kind: "invalid" });
  });
});
