import { afterEach, expect, it, vi } from "vitest";

const remote = { platform: "web" };
vi.mock("./remoteAdapter", () => ({
  createRemoteWebSwath: () => remote,
  createHybridSwath: () => ({ platform: "darwin" }),
}));
vi.mock("./tauriAdapter", () => ({ createTauriSwath: () => ({ platform: "darwin" }) }));
vi.mock("./browserFixture", () => ({ createBrowserStubSwath: () => ({ platform: "web" }) }));

import { attachSwathAdapterIfMissing } from "./installSwathAdapter";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("uses connector RPC in an embedded Tauri webview", () => {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  vi.stubGlobal("location", { hash: "#swath-embedded" });

  attachSwathAdapterIfMissing();

  expect(window.swath).toBe(remote);
});
