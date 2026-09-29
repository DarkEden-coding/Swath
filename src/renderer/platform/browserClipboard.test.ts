import { afterEach, describe, expect, it, vi } from "vitest";
import { readBrowserClipboard } from "./browserClipboard";

afterEach(() => vi.unstubAllGlobals());

describe("browser clipboard", () => {
  it("reads text locally without contacting a remote server", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        read: async () => [
          {
            types: ["text/plain"],
            getType: async () => new Blob(["viewing device text"]),
          },
        ],
      },
    });
    expect(await readBrowserClipboard()).toEqual({ text: "viewing device text", hasImage: false });
  });

  it("supports text-only browser APIs and reports denied permissions", async () => {
    vi.stubGlobal("navigator", { clipboard: { readText: async () => "text" } });
    expect(await readBrowserClipboard()).toEqual({ text: "text", hasImage: false });
    const denied = new Error("Clipboard permission denied");
    vi.stubGlobal("navigator", {
      clipboard: {
        read: async () => {
          throw denied;
        },
      },
    });
    await expect(readBrowserClipboard()).rejects.toBe(denied);
    vi.stubGlobal("navigator", {});
    await expect(readBrowserClipboard()).rejects.toThrow("HTTPS");
  });

  it("converts image items to the same RGBA payload used by native paste", async () => {
    const close = vi.fn();
    vi.stubGlobal("navigator", {
      clipboard: {
        read: async () => [
          {
            types: ["image/png"],
            getType: async () => new Blob(["image"]),
          },
        ],
      },
    });
    vi.stubGlobal("createImageBitmap", async () => ({ width: 1, height: 1, close }));
    vi.stubGlobal("document", {
      createElement: () => ({
        getContext: () => ({
          drawImage: vi.fn(),
          getImageData: () => ({ data: new Uint8ClampedArray([255, 0, 0, 255]) }),
        }),
      }),
    });
    expect(await readBrowserClipboard()).toEqual({
      text: "",
      hasImage: true,
      imageData: "/wAA/w==",
      imageWidth: 1,
      imageHeight: 1,
    });
    expect(close).toHaveBeenCalledTimes(1);
  });
});
