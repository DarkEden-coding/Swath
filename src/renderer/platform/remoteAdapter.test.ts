import { afterEach, expect, it, vi } from "vitest";
import { createRemoteWebSwath } from "./remoteAdapter";

afterEach(() => vi.unstubAllGlobals());

it("routes the hosted web folder picker to its own connector", async () => {
  const requests: Array<{ method: string; params: unknown }> = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    static CONNECTING = 0;
    readyState = Socket.OPEN;

    constructor(_url: string, _protocols: string[]) {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }

    send(data: string): void {
      const request = JSON.parse(data) as { id: number; method: string; params: unknown };
      requests.push(request);
      queueMicrotask(() =>
        this.dispatchEvent(
          new MessageEvent("message", {
            data: JSON.stringify({
              type: "response",
              id: request.id,
              result: { path: "/projects", parent: "/", folders: [], locations: [] },
            }),
          }),
        ),
      );
    }
  }
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", { origin: "https://host.example" });

  const api = createRemoteWebSwath();
  expect((await api.remote.listFolders("host")).path).toBe("/projects");
  expect((await api.remote.createFolder("host", "/projects", "new project")).path).toBe(
    "/projects",
  );
  expect(requests).toEqual([
    { type: "request", id: 1, method: "directories.list", params: {} },
    {
      type: "request",
      id: 2,
      method: "directories.create",
      params: { path: "/projects", name: "new project" },
    },
  ]);
});
