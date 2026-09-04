import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function directive(policy: string, name: string): string[] {
  const value = policy
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name} `));
  return value?.split(/\s+/).slice(1) ?? [];
}

describe("renderer content security policy", () => {
  it("allows the cross-origin transports used by remote connectors", () => {
    const root = resolve(import.meta.dirname, "../../..");
    const html = readFileSync(resolve(root, "index.html"), "utf8");
    const htmlPolicy = html.match(/http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/)?.[1];
    const tauri = JSON.parse(readFileSync(resolve(root, "src-tauri/tauri.conf.json"), "utf8"));

    expect(htmlPolicy).toBeDefined();
    expect(directive(htmlPolicy!, "connect-src")).toEqual(
      expect.arrayContaining(["https:", "wss:"]),
    );
    expect(directive(htmlPolicy!, "script-src")).toContain("'wasm-unsafe-eval'");
    expect(directive(htmlPolicy!, "connect-src")).toEqual(
      directive(tauri.app.security.csp, "connect-src"),
    );
  });
});
