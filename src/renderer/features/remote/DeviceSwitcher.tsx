import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import { getCurrentWebview, Webview } from "@tauri-apps/api/webview";
import { DeviceLifecycle } from "./deviceLifecycle";
import { isTauriRuntime } from "../../platform/runtime";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useConfigStore } from "../../state/configStore";
import type { RemoteConnection } from "../../../shared/types";

const NO_CONNECTIONS: RemoteConnection[] = [];

type DeviceView = {
  browser: Webview;
  url: string;
  token: string;
};

/** Switches between the mounted local interface and a connector's native browser view. */
export function DeviceSwitcher(): JSX.Element {
  const savedConnections = useConfigStore((state) => state.config?.remoteConnections);
  const connections = savedConnections ?? NO_CONNECTIONS;
  const [selected, setSelected] = useState<string>("");
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const [error, setError] = useState<string>("");
  const [retry, setRetry] = useState(0);
  const area = useRef<HTMLDivElement>(null);
  const views = useRef(new Map<string, DeviceView>());
  const selectedRef = useRef(selected);
  const localEditor = useRef<HTMLElement | null>(null);
  const lifecycle = useRef<DeviceLifecycle<Webview> | null>(null);
  useEffect(() => {
    const mountedViews = views.current;
    const controller: DeviceLifecycle<Webview> = new DeviceLifecycle(
      (label) =>
        isTauriRuntime() ? invoke<void>("select_remote_view", { label }) : Promise.resolve(),
      async () => {
        if (isTauriRuntime()) await getCurrentWebview().setFocus();
        const editor = localEditor.current;
        if (editor?.isConnected && controller.mounted && !controller.desired) editor.focus();
      },
      (cause) => {
        if (controller.mounted)
          setError(`Device switch failed: ${String(cause)}. Use Retry to try again.`);
        else console.error("Device cleanup failed", cause);
      },
    );
    lifecycle.current = controller;
    return () => {
      controller.unmount();
      mountedViews.clear();
    };
  }, []);

  useEffect(() => {
    const remember = (event: FocusEvent): void => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches("input, textarea") || target.isContentEditable)
      )
        localEditor.current = target;
    };
    document.addEventListener("focusin", remember);
    return () => document.removeEventListener("focusin", remember);
  }, []);

  useEffect(() => {
    selectedRef.current = selected;
    lifecycle.current!.select(selected);
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
    const manager = lifecycle.current!;
    for (const [id, view] of views.current) {
      const connection = connections.find((item) => item.id === id);
      if (connection && connection.url === view.url && connection.token === view.token) continue;
      views.current.delete(id);
      manager.remove(id);
    }

    const connection = connections.find((item) => item.id === selected);
    setError("");
    if (connection && area.current && !views.current.has(selected)) {
      const bounds = area.current.getBoundingClientRect();
      let url: URL;
      try {
        url = new URL(connection.url);
      } catch {
        setError(`Invalid URL for ${connection.name}. Check the connection settings.`);
        return;
      }
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
      const browser = new Webview(getCurrentWindow(), `device-${crypto.randomUUID()}`, {
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
      };
      views.current.set(selected, view);
      manager.add(selected, browser);
      void browser
        .once("tauri://created", () => {
          manager.created(connection.id, browser);
        })
        .catch((cause: unknown) =>
          setError(`Could not watch ${connection.name}: ${String(cause)}`),
        );
      void browser
        .once("tauri://error", (event) => {
          if (views.current.get(connection.id) !== view) return;
          views.current.delete(connection.id);
          manager.error(connection.id, browser);
          if (selectedRef.current === connection.id)
            setError(
              `Could not open ${connection.name}: ${JSON.stringify(event.payload)}. Check its URL and connection.`,
            );
        })
        .catch((cause: unknown) =>
          setError(`Could not watch ${connection.name}: ${String(cause)}`),
        );
    }
  }, [selected, connections, retry]);

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

  /** Keep the last editor available while keyboard users navigate the device toolbar. */
  const rememberEditor = (event: React.MouseEvent<HTMLButtonElement>): void => {
    // Pointer activation must not replace the editor with a toolbar button; keyboard focus stays native.
    if (
      event.detail &&
      document.activeElement instanceof HTMLElement &&
      !event.currentTarget.contains(document.activeElement)
    ) {
      const focused = document.activeElement;
      if (focused.matches("input, textarea") || focused.isContentEditable)
        localEditor.current = focused;
    }
  };
  /** Pointer switching must not move DOM focus from the editor onto a toolbar button. */
  const keepPointerFocus = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (event.detail) {
      rememberEditor(event);
      event.preventDefault();
    }
  };

  return (
    <>
      <nav
        aria-label="Devices"
        className="flex min-w-0 max-w-[65%] items-center gap-1 overflow-x-auto px-2 [-webkit-app-region:no-drag] [app-region:no-drag]"
      >
        <button
          type="button"
          aria-current={!selected ? "page" : undefined}
          onMouseDown={keepPointerFocus}
          onClick={(event) => {
            rememberEditor(event);
            lifecycle.current!.select("");
            setSelected("");
          }}
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
              onMouseDown={keepPointerFocus}
              onClick={(event) => {
                rememberEditor(event);
                lifecycle.current!.select(connection.id);
                setSelected(connection.id);
              }}
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
            {error}{" "}
            <button
              type="button"
              onClick={() => {
                lifecycle.current!.reconcile();
                setRetry((value) => value + 1);
              }}
              className="underline"
            >
              Retry
            </button>
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
