import { describe, expect, it } from "vitest";
import { isTauriRuntime } from "./runtime";

describe("runtime detection", () => {
  it("recognizes packaged Tauri pages even when the internal bridge is injected later", () => {
    expect(isTauriRuntime({ location: { protocol: "tauri:" } } as Window)).toBe(true);
  });

  it("does not classify ordinary web pages as Tauri", () => {
    expect(isTauriRuntime({ location: { protocol: "https:" } } as Window)).toBe(false);
  });
});
