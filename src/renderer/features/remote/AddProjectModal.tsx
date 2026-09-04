import { useEffect, useMemo, useState } from "react";
import * as appActions from "../../app/appActions";
import { useConfigStore } from "../../state/configStore";
import { useUiStore } from "../../state/uiStore";
import type { RemoteFolderListing } from "../../../shared/ipc/swath";
import { IconClose, IconFolder } from "../shell/icons";

type Source = "local" | "remote";

export function AddProjectModal(): JSX.Element | null {
  const open = useUiStore((state) => state.addProjectOpen);
  const connections = useConfigStore((state) => state.config?.remoteConnections);
  const machines = useMemo(() => connections ?? [], [connections]);
  const [source, setSource] = useState<Source>("local");
  const [connectionId, setConnectionId] = useState("");
  const [listing, setListing] = useState<RemoteFolderListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    setSource("local");
    setConnectionId(machines[0]?.id ?? "");
    setListing(null);
    setError("");
  }, [open, machines]);

  useEffect(() => {
    if (!open || source !== "remote" || !connectionId) return;
    setLoading(true);
    setError("");
    void window.swath.remote
      .listFolders(connectionId)
      .then(setListing)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }, [connectionId, open, source]);

  if (!open) return null;

  const browse = async (path: string): Promise<void> => {
    setLoading(true);
    setError("");
    try {
      setListing(await window.swath.remote.listFolders(connectionId, path));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const chooseLocal = async (): Promise<void> => {
    await appActions.addWorkspaceFromFolder();
    appActions.closeAddProject();
  };

  const selectedName =
    listing?.path.split(/[\\/]/).filter(Boolean).at(-1) ?? listing?.path ?? "Remote project";

  return (
    <div
      className="fixed inset-0 z-[55] grid place-items-center bg-[rgba(5,7,10,.72)] p-6 backdrop-blur-md"
      onMouseDown={appActions.closeAddProject}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-project-title"
        className="flex max-h-[min(680px,92vh)] w-[min(620px,94vw)] flex-col rounded-xl border border-swath-border-strong bg-swath-panel p-5 shadow-swath-modal"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[.12em] text-swath-accent">
              Project source
            </div>
            <h2 id="add-project-title" className="mt-1 text-xl">
              Add Project
            </h2>
          </div>
          <button
            className="grid size-8 place-items-center rounded-lg border border-swath-border bg-swath-bg"
            onClick={appActions.closeAddProject}
            aria-label="Close"
          >
            <IconClose width={17} />
          </button>
        </header>

        <div
          className="mb-5 grid grid-cols-2 gap-2 rounded-xl border border-swath-border bg-swath-bg p-1.5"
          role="tablist"
          aria-label="Project location"
        >
          {(["local", "remote"] as const).map((option) => (
            <button
              key={option}
              role="tab"
              aria-selected={source === option}
              className={`rounded-lg px-3 py-2 text-sm font-semibold capitalize ${source === option ? "bg-swath-accent text-white" : "text-swath-muted hover:text-swath-text"}`}
              onClick={() => setSource(option)}
            >
              {option}
            </button>
          ))}
        </div>

        {source === "local" ? (
          <div className="grid min-h-56 place-items-center rounded-xl border border-dashed border-swath-border p-8 text-center">
            <div>
              <IconFolder width={30} height={30} className="mx-auto mb-3 text-swath-accent" />
              <h3 className="text-base font-semibold">Folder on this Mac</h3>
              <p className="mb-4 mt-1 text-sm text-swath-muted">
                Choose a local folder using the native file picker.
              </p>
              <button
                className="rounded-lg bg-swath-accent px-4 py-2 text-sm font-semibold text-white"
                onClick={() => void chooseLocal()}
              >
                Choose Local Folder
              </button>
            </div>
          </div>
        ) : machines.length === 0 ? (
          <div className="grid min-h-56 place-items-center rounded-xl border border-dashed border-swath-border p-8 text-center">
            <div>
              <h3 className="text-base font-semibold">No remote machines</h3>
              <p className="mt-1 text-sm text-swath-muted">
                Add a remote connection in Settings first.
              </p>
              <button
                className="mt-4 rounded-lg border border-swath-accent px-4 py-2 text-sm font-semibold text-swath-accent-strong"
                onClick={() => {
                  appActions.closeAddProject();
                  appActions.openSettings();
                }}
              >
                Open Settings
              </button>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-3">
            <label className="grid gap-1.5 text-xs font-semibold text-swath-muted">
              Remote machine
              <select
                className="rounded-lg border border-swath-border bg-swath-bg px-3 py-2.5 text-swath-text outline-none focus:border-swath-accent"
                value={connectionId}
                onChange={(event) => {
                  setConnectionId(event.target.value);
                  setListing(null);
                }}
              >
                {machines.map((machine) => (
                  <option key={machine.id} value={machine.id}>
                    {machine.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-swath-border bg-swath-bg">
              <div className="flex items-center gap-2 border-b border-swath-border px-3 py-2 font-mono text-xs text-swath-muted">
                <button
                  disabled={!listing?.parent || loading}
                  className="rounded border border-swath-border px-2 py-1 disabled:opacity-40"
                  onClick={() => listing?.parent && void browse(listing.parent)}
                >
                  Up
                </button>
                <span className="min-w-0 truncate" title={listing?.path}>
                  {listing?.path ?? "Loading home folder…"}
                </span>
              </div>
              <div className="min-h-48 flex-1 overflow-y-auto p-1.5">
                {loading ? (
                  <p className="p-3 text-sm text-swath-muted">Loading folders…</p>
                ) : listing?.folders.length ? (
                  listing.folders.map((folder) => (
                    <button
                      key={folder.path}
                      className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-swath-panel"
                      onDoubleClick={() => void browse(folder.path)}
                      onClick={() => void browse(folder.path)}
                    >
                      <IconFolder width={16} className="text-swath-accent" />
                      <span className="truncate">{folder.name}</span>
                    </button>
                  ))
                ) : (
                  <p className="p-3 text-sm text-swath-muted">This folder has no subfolders.</p>
                )}
              </div>
            </div>
            {error ? (
              <p role="alert" className="text-xs text-swath-danger">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <button
                className="rounded-lg border border-swath-border px-3 py-2 text-sm"
                onClick={appActions.closeAddProject}
              >
                Cancel
              </button>
              <button
                disabled={!listing || loading}
                className="rounded-lg bg-swath-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"
                onClick={() =>
                  listing && appActions.addRemoteWorkspace(connectionId, listing.path, selectedName)
                }
              >
                Add This Folder
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
