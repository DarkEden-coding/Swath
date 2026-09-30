import { useEffect, useRef, useState } from "react";
import { parseRemotePath } from "../../../shared/ipc/remote";
import { useConfigStore } from "../../state/configStore";
import { collectPanes } from "../../domain/layout/layoutTree";

/** Blocks interaction with a previously connected remote workspace until its connection recovers. */
export function RemoteReconnectModal(): JSX.Element | null {
  const config = useConfigStore((state) => state.config);
  const [established, setEstablished] = useState(new Set<string>());
  const [statuses, setStatuses] = useState<Record<string, string>>({});
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const update = (id: string, status: string): void => {
      if (status === "connected")
        setEstablished((previous) => (previous.has(id) ? previous : new Set([...previous, id])));
      setStatuses((previous) => ({ ...previous, [id]: status }));
    };
    const off = window.swath.remote.onStatus(update);
    for (const id of ["host", ...(config?.remoteConnections ?? []).map((item) => item.id)])
      update(id, window.swath.remote.status(id));
    return off;
  }, [config?.remoteConnections]);
  const workspace = config?.workspaces.find((item) => item.id === config.activeWorkspaceId);
  const relevant =
    window.swath.platform === "web"
      ? ["host"]
      : [
          workspace?.remoteConnectionId ?? parseRemotePath(workspace?.path ?? "")?.connectionId,
          ...(workspace?.views ?? []).flatMap((view) =>
            collectPanes(view.layout).map(
              (pane) =>
                parseRemotePath(pane.metadata?.cwd ?? pane.terminal?.cwd ?? pane.cwd ?? "")
                  ?.connectionId,
            ),
          ),
        ];
  const id = relevant.find(
    (candidate) => candidate && established.has(candidate) && statuses[candidate] !== "connected",
  );
  const open = !!id;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    button.current?.focus();
    const keydown = (event: KeyboardEvent): void => {
      // This recovery dialog cannot be dismissed while the device is unavailable.
      if (event.key === "Tab") {
        event.preventDefault();
        button.current?.focus();
      }
      event.stopImmediatePropagation();
    };
    const focus = (event: FocusEvent): void => {
      if (event.target !== button.current) button.current?.focus();
    };
    window.addEventListener("keydown", keydown, true);
    document.addEventListener("focusin", focus);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      document.removeEventListener("focusin", focus);
      if (previous?.isConnected) previous.focus();
    };
  }, [open]);
  if (!open) return null;
  const name = config?.remoteConnections?.find((item) => item.id === id)?.name ?? "remote host";
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-[rgba(5,7,10,.72)] p-6 backdrop-blur-md [-webkit-app-region:no-drag]">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="reconnect-title"
        aria-describedby="reconnect-description"
        className="w-[min(500px,94vw)] rounded-xl border border-swath-border-strong bg-swath-panel p-5 text-swath-text shadow-swath-modal"
      >
        <div className="text-[11px] font-bold uppercase tracking-[.12em] text-swath-accent">
          Remote connector
        </div>
        <h2 id="reconnect-title" className="mt-1 text-xl">
          Connection lost
        </h2>
        <p
          id="reconnect-description"
          role="status"
          className="my-4 text-sm leading-relaxed text-swath-muted"
        >
          Reconnecting to {name} automatically. Interrupted operations are not retried; check their
          outcome before trying again.
        </p>
        <div className="flex justify-end">
          <button
            ref={button}
            onClick={() => window.location.reload()}
            className="rounded-lg border border-swath-border bg-swath-bg px-3 py-2 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-swath-accent"
          >
            Reload page
          </button>
        </div>
      </section>
    </div>
  );
}
