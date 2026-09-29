import { useEffect, useRef, useState } from "react";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useConfigStore } from "../../state/configStore";
import type { RemoteConnection } from "../../../shared/types";

const NO_CONNECTIONS: RemoteConnection[] = [];

type DeviceView = {
  browser: Webview;
  url: string;
  token: string;
  created: boolean;
  visibility: Promise<void>;
};

/** Applies visibility changes in switch order, even when native calls finish out of order. */
function setViewVisible(view: DeviceView, visible: boolean): void {
  view.visibility = view.visibility
    .then(() => (visible ? view.browser.show() : view.browser.hide()))
    .catch(console.error);
}

/** Switches between the mounted local interface and a connector's native browser view. */
export function DeviceSwitcher(): JSX.Element {
  const savedConnections = useConfigStore((state) => state.config?.remoteConnections);
  const connections = savedConnections ?? NO_CONNECTIONS;
  const [selected, setSelected] = useState<string>("");
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>("");
  const area = useRef<HTMLDivElement>(null);
  const views = useRef(new Map<string, DeviceView>());
  const selectedRef = useRef(selected);
  const generation = useRef(0);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    const update = (id: string, status: string): void => {
      setStatuses((current) => ({ ...current, [id]: status }));
    };
    for (const connection of connections)
      update(connection.id, window.swath.remote.status(connection.id));
    return window.swath.remote.onStatus(update);
  }, [connections]);

  useEffect(() => {
    if (selected && !connections.some((connection) => connection.id === selected)) setSelected("");
  }, [connections, selected]);

  useEffect(() => {
    for (const [id, view] of views.current) {
      const connection = connections.find((item) => item.id === id);
      if (connection && connection.url === view.url && connection.token === view.token) continue;
      views.current.delete(id);
      if (view.created) void view.visibility.then(() => view.browser.close()).catch(console.error);
    }

    const connection = connections.find((item) => item.id === selected);
    setError("");
    if (connection && area.current && !views.current.has(selected)) {
      const bounds = area.current.getBoundingClientRect();
      const url = new URL(connection.url);
      if (
        url.protocol !== "https:" &&
        !(url.protocol === "http:" && url.hostname === "127.0.0.1")
      ) {
        setError("Remote UI requires HTTPS (or local loopback HTTP).");
        return;
      }
      url.pathname = "/";
      url.search = "";
      url.hash = "";
      url.searchParams.set("token", connection.token);
      url.hash = "swath-embedded";
      const browser = new Webview(getCurrentWindow(), `device-${++generation.current}`, {
        url: url.toString(),
        x: bounds.left,
        y: bounds.top,
        width: bounds.width,
        height: bounds.height,
      });
      const view: DeviceView = {
        browser,
        url: connection.url,
        token: connection.token,
        created: false,
        visibility: Promise.resolve(),
      };
      views.current.set(selected, view);
      void browser.once("tauri://created", () => {
        view.created = true;
        if (views.current.get(connection.id) !== view) void browser.close().catch(console.error);
        else if (selectedRef.current !== connection.id) setViewVisible(view, false);
      });
      void browser.once("tauri://error", () => {
        if (selectedRef.current === connection.id) setError(`Could not open ${connection.name}.`);
      });
    }
    for (const [id, view] of views.current) {
      if (!view.created) continue;
      setViewVisible(view, id === selected);
    }
  }, [selected, connections]);

  useEffect(() => {
    if (!selected || !area.current) return;
    const sync = (): void => {
      const rect = area.current?.getBoundingClientRect();
      const browser = views.current.get(selected)?.browser;
      if (!rect || !browser) return;
      void Promise.all([
        browser.setPosition(new LogicalPosition(rect.left, rect.top)),
        browser.setSize(new LogicalSize(rect.width, rect.height)),
      ]).catch(console.error);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(area.current);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
    };
  }, [selected]);

  useEffect(
    () => () => {
      for (const view of views.current.values()) {
        if (view.created)
          void view.visibility.then(() => view.browser.close()).catch(console.error);
      }
      views.current.clear();
    },
    [],
  );

  return (
    <>
      <nav
        aria-label="Devices"
        className="flex min-w-0 max-w-[65%] items-center gap-1 overflow-x-auto px-2 [-webkit-app-region:no-drag] [app-region:no-drag]"
      >
        <button
          type="button"
          aria-current={!selected ? "page" : undefined}
          onClick={() => setSelected("")}
          className={`flex h-7 shrink-0 items-center gap-2 rounded-md border px-3 text-xs transition-colors ${!selected ? "border-swath-accent bg-swath-bg text-swath-text" : "border-swath-border text-swath-muted hover:bg-swath-panel-2 hover:text-swath-text"}`}
        >
          <span className="size-2 rounded-full bg-swath-good" aria-hidden="true" />
          This device
        </button>
        {connections.map((connection) => {
          const online = statuses[connection.id] === "connected";
          return (
            <button
              type="button"
              key={connection.id}
              disabled={!online}
              aria-current={selected === connection.id ? "page" : undefined}
              title={`${connection.name} (${online ? "online" : "offline"})`}
              onClick={() => setSelected(connection.id)}
              className={`flex h-7 max-w-48 shrink-0 items-center gap-2 rounded-md border px-3 text-xs transition-colors ${selected === connection.id ? "border-swath-accent bg-swath-bg text-swath-text" : online ? "border-swath-border text-swath-text hover:bg-swath-panel-2" : "cursor-not-allowed border-swath-border text-swath-muted opacity-60"}`}
            >
              <span
                className={`size-2 shrink-0 rounded-full ${online ? "bg-swath-good" : "bg-swath-muted-2"}`}
                aria-hidden="true"
              />
              <span className="truncate">{connection.name}</span>
            </button>
          );
        })}
        {error && (
          <span role="alert" className="shrink-0 text-xs text-swath-danger">
            {error}
          </span>
        )}
      </nav>
      <div
        ref={area}
        className={selected ? "absolute inset-x-0 bottom-0 top-10 pointer-events-none" : "hidden"}
        aria-hidden="true"
      />
    </>
  );
}
