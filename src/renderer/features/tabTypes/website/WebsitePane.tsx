import { useEffect, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { Webview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalPosition, LogicalSize } from "@tauri-apps/api/dpi";
import * as appActions from "../../../app/appActions";
import type { PaneComponentProps } from "../../panes/paneTypes";
import { websiteAddressFrom } from "./websiteAddress";

/** Embedded browser surface for a persisted website address. */
export function WebsitePane({ workspace, view, pane }: PaneComponentProps): JSX.Element {
  const storedAddress = pane.metadata?.websiteAddress ?? "";
  const input = useRef<HTMLInputElement>(null);
  const browserArea = useRef<HTMLDivElement>(null);
  const [browserError, setBrowserError] = useState("");
  const [localFrame, setLocalFrame] = useState<{ source: string; url?: string; error?: string }>();
  const address = websiteAddressFrom(storedAddress);
  useEffect(() => {
    if (!address?.url.startsWith("file:") || !isTauri()) return;
    let active = true;
    const pathname = decodeURIComponent(new URL(address.url).pathname).replace(
      /^\/(?=[A-Za-z]:\/)/,
      "",
    );
    void invoke("website_allow_local_file", { path: pathname })
      .then(() => {
        if (active) {
          // Keep path separators in the URL so relative CSS and scripts resolve beside the HTML file.
          const url = convertFileSrc(pathname).replace(/%2F|%5C/gi, "/");
          setLocalFrame({ source: address.url, url });
        }
      })
      .catch((error: unknown) => {
        if (active) setLocalFrame({ source: address.url, error: String(error) });
      });
    return () => {
      active = false;
    };
  }, [address?.url]);

  const submit = (): void => {
    const next = websiteAddressFrom(input.current?.value ?? "");
    if (!next) return;
    appActions.setWebsiteAddress(workspace.id, view.id, pane.id, next.url, next.title);
  };

  const fileUnavailable = address?.url.startsWith("file:") && !isTauri();
  const navigableUrl = address?.url.startsWith("file:") ? localFrame?.url : address?.url;

  useEffect(() => {
    if (!isTauri() || !navigableUrl || !browserArea.current) return;
    const area = browserArea.current;
    const bounds = area.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const webview = new Webview(getCurrentWindow(), `swath-site-${pane.id}-${Date.now()}`, {
      url: navigableUrl,
      x: bounds.left,
      y: bounds.top,
      width: bounds.width,
      height: bounds.height,
      focus: false,
    });
    let closed = false;
    let created = false;
    void webview.once("tauri://error", (event) => {
      if (!closed) setBrowserError(String(event.payload));
    });
    const resize = (): void => {
      if (closed || !created) return;
      const rect = area.getBoundingClientRect();
      void Promise.all([
        webview.setPosition(new LogicalPosition(rect.left, rect.top)),
        webview.setSize(new LogicalSize(rect.width, rect.height)),
      ]).catch((error: unknown) => setBrowserError(String(error)));
    };
    void webview.once("tauri://created", () => {
      created = true;
      if (closed) void webview.close();
      else resize();
    });
    const observer = new ResizeObserver(resize);
    observer.observe(area);
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", resize, true);
    return () => {
      closed = true;
      observer.disconnect();
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", resize, true);
      if (created) void webview.close();
    };
  }, [navigableUrl, pane.id]);
  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden rounded-md border border-swath-border bg-swath-bg">
      <form
        className="flex gap-2 border-b border-swath-border bg-swath-panel p-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          aria-label="Website address"
          className="min-w-0 flex-1 rounded border border-swath-border bg-swath-bg px-2 py-1 text-sm text-swath-text outline-none focus:border-swath-accent"
          placeholder="https://example.com, http://localhost:3000, or /path/page.html"
          key={storedAddress}
          ref={input}
          defaultValue={storedAddress}
        />
        <button
          type="submit"
          className="cursor-pointer rounded border border-swath-border px-3 py-1 text-sm text-swath-text hover:border-swath-accent"
        >
          Open
        </button>
      </form>
      {!storedAddress ? (
        <p className="m-auto max-w-md p-4 text-center text-sm text-swath-muted">
          Enter an HTTPS URL, localhost URL, or local .html file.
        </p>
      ) : !address ? (
        <p className="m-auto max-w-md p-4 text-center text-sm text-swath-warn">
          Use HTTPS, localhost HTTP, or a local .html file.
        </p>
      ) : fileUnavailable ? (
        <p className="m-auto max-w-md p-4 text-center text-sm text-swath-muted">
          Local files can only open in the desktop app.
        </p>
      ) : address.url.startsWith("file:") && localFrame?.source !== address.url ? (
        <p className="m-auto p-4 text-sm text-swath-muted">Opening local HTML file...</p>
      ) : localFrame?.source === address.url && localFrame.error ? (
        <p className="m-auto p-4 text-sm text-swath-warn">{localFrame.error}</p>
      ) : browserError ? (
        <p className="m-auto p-4 text-sm text-swath-warn">{browserError}</p>
      ) : (
        <div ref={browserArea} className="min-h-0 w-full flex-1 bg-white">
          {!isTauri() ? (
            <iframe
              key={address.url}
              className="h-full w-full border-0"
              src={address.url}
              title={pane.title ?? pane.metadata?.title ?? address.title}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}
