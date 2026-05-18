import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTerminalSelection } from "./useTerminalClipboard";

describe("copyTerminalSelection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes terminal selection through the Electron clipboard bridge", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const browserWriteText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { swath: { clipboard: { writeText } } });
    vi.stubGlobal("navigator", { clipboard: { writeText: browserWriteText } });

    await copyTerminalSelection("Error: Failed to load extension");

    expect(writeText).toHaveBeenCalledWith("Error: Failed to load extension");
    expect(browserWriteText).not.toHaveBeenCalled();
  });

  it("falls back to the browser clipboard when the bridge is unavailable", async () => {
    const browserWriteText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText: browserWriteText } });

    await copyTerminalSelection("ParseError: Unexpected token");

    expect(browserWriteText).toHaveBeenCalledWith("ParseError: Unexpected token");
  });

  it("does not alter the clipboard without a terminal selection", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const browserWriteText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { swath: { clipboard: { writeText } } });
    vi.stubGlobal("navigator", { clipboard: { writeText: browserWriteText } });

    await copyTerminalSelection("");
    await copyTerminalSelection(undefined);

    expect(writeText).not.toHaveBeenCalled();
    expect(browserWriteText).not.toHaveBeenCalled();
  });
});
