import { useEffect, useRef, useState } from "react";
import * as appActions from "../../app/appActions";
import { useUiStore } from "../../state/uiStore";
import { IconClose } from "../shell/icons";

const input =
  "w-full rounded-lg border border-swath-border bg-swath-bg px-3 py-2.5 text-swath-text outline-none focus:border-swath-accent";

export function RemoteConnectModal(): JSX.Element | null {
  const open = useUiStore((state) => state.remoteConnectOpen);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) requestAnimationFrame(() => ref.current?.focus());
  }, [open]);
  if (!open) return null;

  const connect = async (): Promise<void> => {
    if (!url.trim() || token.length < 16) {
      setError("Enter a device address and a token of at least 16 characters.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await appActions.connectRemote(url, token);
      setUrl("");
      setToken("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center bg-[rgba(5,7,10,.72)] p-6 backdrop-blur-md"
      onMouseDown={appActions.closeRemoteConnect}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="remote-title"
        className="w-[min(500px,94vw)] rounded-xl border border-swath-border-strong bg-swath-panel p-5 shadow-swath-modal"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[.12em] text-swath-accent">
              Remote connector
            </div>
            <h2 id="remote-title" className="mt-1 text-xl">
              Connect to Remote
            </h2>
          </div>
          <button
            className="grid size-8 place-items-center rounded-lg border border-swath-border bg-swath-bg"
            onClick={appActions.closeRemoteConnect}
            aria-label="Close"
          >
            <IconClose width={17} />
          </button>
        </header>
        <p className="mb-4 text-sm leading-relaxed text-swath-muted">
          Connect to another Swath device over Tailscale or a trusted network. Its terminals, files,
          Git tools, and Pi CodingAgents run on that device.
        </p>
        <div className="grid gap-3">
          <label className="grid gap-1.5 text-xs font-semibold text-swath-muted">
            Device address
            <input
              ref={ref}
              className={input}
              placeholder="http://devbox.tailnet.ts.net:7878"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-xs font-semibold text-swath-muted">
            Access token
            <input
              className={input}
              type="password"
              autoComplete="off"
              placeholder="Connector token"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void connect();
              }}
            />
          </label>
        </div>
        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-swath-danger/40 bg-swath-danger/10 p-2.5 text-xs text-swath-danger"
          >
            {error}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-swath-border px-3 py-2 text-sm"
            onClick={appActions.closeRemoteConnect}
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-swath-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            disabled={busy}
            onClick={() => void connect()}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </section>
    </div>
  );
}
