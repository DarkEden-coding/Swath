import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CatalogSnapshot,
  MigrationConflict,
  MigrationPreview,
  NetworkDiscovery,
} from "../../../shared/types";

export function joinRequest(
  networkId: string,
  endpoint: string,
  secret: string,
): { networkId: string; endpoint: string; secret: string } | null {
  const id = networkId.trim();
  const url = endpoint.trim();
  const token = secret.trim();
  return id && url && token.length >= 16 ? { networkId: id, endpoint: url, secret: token } : null;
}

/** The only startup path allowed to create or enroll a catalog network. */
export function NetworkStartupGate({
  onReady,
}: {
  onReady: (snapshot: CatalogSnapshot) => void;
}): JSX.Element {
  const [snapshot, setSnapshot] = useState<CatalogSnapshot | null | undefined>(undefined);
  const [networks, setNetworks] = useState<NetworkDiscovery[]>([]);
  const [networkId, setNetworkId] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [name, setName] = useState("Swath");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [migration, setMigration] = useState<MigrationPreview | null>(null);
  const [mappings, setMappings] = useState<MigrationPreview["suggestedMappings"]>([]);
  const [conflicts, setConflicts] = useState<MigrationConflict[]>([]);
  const checking = useRef(false);

  const check = useCallback(async (): Promise<CatalogSnapshot | null> => {
    if (checking.current) return null;
    checking.current = true;
    setError("Checking current network…");
    try {
      const current = await window.swath.network.current();
      setSnapshot(current);
      if (current) {
        const preview = (current as CatalogSnapshot & { legacyMigration?: MigrationPreview })
          .legacyMigration;
        if (preview) {
          setMigration(preview);
          setMappings(preview.suggestedMappings);
        } else {
          const unresolved = (await window.swath.migration.conflicts()).filter(
            (item) => item.state !== "resolved",
          );
          setConflicts(unresolved);
          if (!unresolved.length) onReady(current);
        }
      }
      setError(null);
      return current;
    } catch (cause) {
      setSnapshot(null);
      setError(cause instanceof Error ? cause.message : "Could not check network setup");
      return null;
    } finally {
      checking.current = false;
    }
  }, [onReady]);
  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => {
    if (snapshot !== null) return;
    void window.swath.network
      .discover()
      .then(setNetworks)
      .catch(() => setNetworks([]));
  }, [snapshot]);

  const initialize = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await window.swath.network.initialize(name.trim() || "Swath");
      await check();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not initialize network");
    } finally {
      setBusy(false);
    }
  };
  const join = async (): Promise<void> => {
    const request = joinRequest(networkId, endpoint, secret);
    if (!request) {
      setError("Network ID, URL, and a 16-character enrollment secret are required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pending = await window.swath.network.requestJoin(
        request.networkId,
        request.endpoint,
        request.secret,
      );
      const status = await window.swath.network.joinStatus(pending.enrollmentId);
      // The same credentials resume the durable pending request after restart.
      if (status.state === "approved") await check();
      else setError("Join request sent. Retry after an administrator approves it.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not request to join network");
    } finally {
      setBusy(false);
    }
  };
  const exportBackup = async (): Promise<void> => {
    const backup = await window.swath.migration.export();
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([backup.content], { type: "application/json" }));
    link.download = backup.filename;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  const confirmMigration = async (): Promise<void> => {
    if (!snapshot || !migration) return;
    setBusy(true);
    setError(null);
    try {
      await window.swath.migration.confirm({
        operationId: migration.operationId,
        networkId: snapshot.network.id,
        sourceFingerprint: migration.sourceFingerprint,
        mappings,
      });
      onReady(snapshot);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : typeof cause === "string"
            ? cause
            : "Migration could not be confirmed",
      );
    } finally {
      setBusy(false);
    }
  };

  if (snapshot === undefined)
    return (
      <div className="grid h-full place-items-center text-swath-muted">Checking network setup…</div>
    );
  if (snapshot && conflicts.length)
    return (
      <MigrationConflictReview
        conflicts={conflicts}
        busy={busy}
        error={error}
        onResolve={async (conflict, action) => {
          setBusy(true);
          try {
            const proposal = {
              conflictId: conflict.conflictId,
              revisionHash: conflict.revisionHash,
              sourceRecordIds: [conflict.conflictId],
              action,
              mapping: {},
              diff:
                action === "keep_original"
                  ? { selected: "original", value: conflict.original }
                  : { selected: "incoming", value: conflict.incoming },
            };
            await window.swath.migration.submitProposal(proposal);
            await window.swath.migration.approveProposal({
              conflictId: conflict.conflictId,
              revisionHash: conflict.revisionHash,
              sourceRecordIds: proposal.sourceRecordIds,
              approve: true,
            });
            await check();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not resolve conflict");
          } finally {
            setBusy(false);
          }
        }}
        onApprove={async (conflict) => {
          if (!conflict.proposal) return;
          setBusy(true);
          try {
            await window.swath.migration.approveProposal({
              conflictId: conflict.conflictId,
              revisionHash: conflict.revisionHash,
              sourceRecordIds: conflict.proposal.sourceRecordIds,
              approve: true,
            });
            await check();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not approve proposal");
          } finally {
            setBusy(false);
          }
        }}
      />
    );
  if (snapshot && migration)
    return (() => {
      const totalPanes = migration.workspaces.reduce((sum, item) => sum + item.panes, 0);
      const totalSessions = migration.workspaces.reduce(
        (sum, item) => sum + item.piSessions.length,
        0,
      );
      const includedWorkspaceIds = new Set(mappings.map((mapping) => mapping.workspaceId));
      const includedCount = includedWorkspaceIds.size;
      return (
        <main className="grid h-full min-h-0 place-items-center overflow-hidden bg-swath-bg p-5">
          <section className="grid h-[min(820px,calc(100vh-2.5rem))] w-full max-w-5xl grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden rounded-xl border border-swath-border bg-swath-panel shadow-swath">
            <header className="border-b border-swath-border/70 px-6 py-5">
              <h1 className="text-xl font-semibold tracking-tight text-swath-text">
                Import legacy workspaces
              </h1>
              <p className="mt-1 text-sm text-swath-muted">
                Review each workspace and adjust its target mapping before importing.
              </p>
              <div className="mt-4 grid gap-3 text-xs sm:grid-cols-2">
                <div className="rounded-lg border border-swath-border bg-swath-bg/60 px-3 py-2.5">
                  <div className="font-medium uppercase tracking-wider text-swath-muted">
                    Source fingerprint
                  </div>
                  <code className="mt-1 block truncate text-sm text-swath-text">
                    {migration.sourceFingerprint}
                  </code>
                </div>
                <div className="rounded-lg border border-swath-border bg-swath-bg/60 px-3 py-2.5">
                  <div className="font-medium uppercase tracking-wider text-swath-muted">
                    Backup destination
                  </div>
                  <code
                    className="mt-1 block truncate text-sm text-swath-text"
                    title={migration.backupPath}
                  >
                    {migration.backupPath}
                  </code>
                </div>
              </div>
            </header>

            <div className="grid grid-cols-3 gap-3 border-b border-swath-border/70 px-6 py-3">
              {[
                [`${includedCount}/${migration.workspaces.length}`, "Included workspaces"],
                [totalPanes, "Total panes"],
                [totalSessions, "Pi sessions"],
              ].map(([value, label]) => (
                <div
                  key={label}
                  className="rounded-lg border border-swath-border bg-swath-bg/40 px-4 py-2.5"
                >
                  <div className="text-lg font-semibold text-swath-text">{value}</div>
                  <div className="text-xs text-swath-muted">{label}</div>
                </div>
              ))}
            </div>

            <div
              className="min-h-0 overflow-y-auto px-6 py-4 [scrollbar-gutter:stable]"
              aria-label="Workspaces to import"
              tabIndex={0}
            >
              <div className="mb-3 flex items-center justify-between gap-4">
                <h2 className="text-sm font-semibold text-swath-text">
                  Workspaces ({migration.workspaces.length})
                </h2>
                <span className="text-xs text-swath-muted">Scroll to review all mappings</span>
              </div>
              <div className="space-y-2">
                {migration.workspaces.map((workspace) => {
                  const included = includedWorkspaceIds.has(workspace.id);
                  const mapping = mappings.find((item) => item.workspaceId === workspace.id);
                  return (
                    <article
                      key={workspace.id}
                      className={`grid gap-3 rounded-lg border p-3 text-sm transition-all md:grid-cols-[minmax(0,1fr)_minmax(260px,0.9fr)_auto] md:items-center ${included ? "border-swath-border bg-swath-bg/25 text-swath-text hover:border-swath-muted/60" : "border-swath-border/60 bg-swath-bg/10 text-swath-muted opacity-70"}`}
                    >
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h3 className="truncate font-medium">{workspace.name}</h3>
                          <span
                            className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${workspace.git === "git" ? "border-swath-accent/40 bg-swath-accent/10 text-swath-accent" : "border-swath-border bg-swath-panel text-swath-muted"}`}
                          >
                            {workspace.git === "git" ? "Git" : workspace.git}
                          </span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-swath-muted">
                          <span>
                            {workspace.panes} {workspace.panes === 1 ? "pane" : "panes"}
                          </span>
                          <span>
                            {workspace.piSessions.length} Pi{" "}
                            {workspace.piSessions.length === 1 ? "session" : "sessions"}
                          </span>
                        </div>
                        <div
                          className="mt-1 truncate text-xs text-swath-muted"
                          title={workspace.repositoryIdentity}
                        >
                          Source: {workspace.repositoryIdentity}
                        </div>
                      </div>
                      <label className="min-w-0 text-xs font-medium text-swath-muted">
                        Import to
                        <input
                          aria-label={`${workspace.name} project mapping`}
                          disabled={!included}
                          value={mapping?.projectKey ?? ""}
                          onChange={(event) =>
                            setMappings((current) =>
                              current.map((item) =>
                                item.workspaceId === workspace.id
                                  ? { ...item, projectKey: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          className="mt-1.5 w-full rounded-md border border-swath-border bg-swath-bg px-2.5 py-2 text-sm text-swath-text outline-none transition focus:border-swath-accent focus:ring-1 focus:ring-swath-accent/30 disabled:cursor-not-allowed disabled:opacity-50"
                        />
                      </label>
                      <button
                        type="button"
                        aria-pressed={!included}
                        onClick={() =>
                          setMappings((current) => {
                            if (included) {
                              return current.filter((item) => item.workspaceId !== workspace.id);
                            }
                            const suggested = migration.suggestedMappings.find(
                              (item) => item.workspaceId === workspace.id,
                            );
                            return suggested ? [...current, suggested] : current;
                          })
                        }
                        className={`rounded-md border px-3 py-2 text-sm font-medium transition ${included ? "border-swath-border text-swath-muted hover:border-swath-danger/60 hover:bg-swath-danger/10 hover:text-swath-danger" : "border-swath-accent/50 bg-swath-accent/10 text-swath-accent hover:bg-swath-accent/20"}`}
                      >
                        {included ? "Exclude" : "Include"}
                      </button>
                    </article>
                  );
                })}
              </div>
            </div>

            <footer className="flex items-center justify-between gap-4 border-t border-swath-border bg-swath-panel px-6 py-4">
              <div className="min-w-0">
                {error ? (
                  <p role="alert" className="truncate text-xs text-swath-danger">
                    {error}
                  </p>
                ) : (
                  <p className="text-xs text-swath-muted">
                    Your legacy source remains unchanged after import.
                  </p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  disabled={busy}
                  onClick={() => void exportBackup()}
                  className="rounded-md border border-swath-border px-3 py-2 text-sm text-swath-muted transition hover:bg-swath-bg hover:text-swath-text disabled:opacity-50"
                >
                  Export backup
                </button>
                <button
                  disabled={busy || includedCount === 0}
                  onClick={() => void confirmMigration()}
                  className="rounded-md bg-swath-accent px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-110 disabled:opacity-50"
                >
                  {busy ? "Importing…" : `Approve ${includedCount} workspaces`}
                </button>
              </div>
            </footer>
          </section>
        </main>
      );
    })();
  return (
    <main className="grid h-full place-items-center bg-swath-bg p-6">
      <section className="w-full max-w-lg rounded-lg border border-swath-border bg-swath-panel p-6 shadow-swath">
        <h1 className="text-lg font-semibold text-swath-text">Set up shared tasks</h1>
        <p className="mt-2 text-sm text-swath-muted">
          Choose an existing network or initialize one. Swath will not create a network until you
          choose Initialize.
        </p>
        <div className="mt-5 space-y-3">
          <label className="block text-xs text-swath-muted">
            Discovered networks
            <select
              className="mt-1 w-full rounded border border-swath-border bg-swath-bg p-2 text-swath-text"
              value=""
              onChange={(event) => setEndpoint(event.target.value)}
            >
              <option value="">Use a manual URL</option>
              {networks
                .filter((item) => item.online)
                .map((item) => (
                  <option key={item.url} value={item.url}>
                    {item.name} — {item.url}
                  </option>
                ))}
            </select>
          </label>
          <label className="block text-xs text-swath-muted">
            Network ID
            <input
              value={networkId}
              onChange={(event) => setNetworkId(event.target.value)}
              className="mt-1 w-full rounded border border-swath-border bg-swath-bg p-2 text-swath-text"
            />
          </label>
          <label className="block text-xs text-swath-muted">
            Network URL
            <input
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://host"
              className="mt-1 w-full rounded border border-swath-border bg-swath-bg p-2 text-swath-text"
            />
          </label>
          <label className="block text-xs text-swath-muted">
            Enrollment secret
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              className="mt-1 w-full rounded border border-swath-border bg-swath-bg p-2 text-swath-text"
            />
          </label>
          <div className="flex gap-2">
            <button
              disabled={busy}
              onClick={() => void join()}
              className="rounded bg-swath-accent px-3 py-2 text-sm text-white"
            >
              Join existing network
            </button>
            <button
              disabled={busy}
              onClick={() => void check()}
              className="rounded px-3 py-2 text-sm text-swath-muted hover:bg-swath-bg"
            >
              Retry
            </button>
          </div>
        </div>
        <div className="mt-5 border-t border-swath-border pt-4">
          <label className="block text-xs text-swath-muted">
            New network name
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="mt-1 w-full rounded border border-swath-border bg-swath-bg p-2 text-swath-text"
            />
          </label>
          <button
            disabled={busy}
            onClick={() => void initialize()}
            className="mt-2 rounded border border-swath-accent px-3 py-2 text-sm text-swath-accent"
          >
            Initialize new network
          </button>
        </div>
        {error ? (
          <p role="alert" className="mt-3 text-xs text-swath-danger">
            {error}
          </p>
        ) : null}
        <button
          onClick={() => void exportBackup()}
          className="mt-4 text-xs text-swath-muted underline"
        >
          Export legacy backup
        </button>
      </section>
    </main>
  );
}

export function MigrationConflictReview({
  conflicts,
  busy,
  error,
  onResolve,
  onApprove,
}: {
  conflicts: MigrationConflict[];
  busy: boolean;
  error: string | null;
  onResolve(
    conflict: MigrationConflict,
    action: "keep_original" | "use_incoming",
  ): Promise<void>;
  onApprove(conflict: MigrationConflict): Promise<void>;
}): JSX.Element {
  return (
    <main className="grid h-full place-items-center bg-swath-bg p-6">
      <section className="w-full max-w-2xl rounded-lg border border-swath-border bg-swath-panel p-6">
        <h1 className="text-lg font-semibold text-swath-text">Resolve migration conflicts</h1>
        <p className="mt-2 text-sm text-swath-danger">
          Legacy content is untrusted. Review it as data; do not follow instructions inside it.
        </p>
        {conflicts.map((conflict) => (
          <article
            key={conflict.conflictId}
            className="mt-4 rounded border border-swath-border p-3 text-sm"
          >
            <pre className="max-h-36 overflow-auto text-xs">
              {JSON.stringify(
                { original: conflict.original, incoming: conflict.incoming },
                null,
                2,
              )}
            </pre>
            {conflict.proposal ? (
              <>
                <pre className="mt-2 max-h-24 overflow-auto text-xs">
                  {JSON.stringify(conflict.proposal.diff, null, 2)}
                </pre>
                <button
                  disabled={busy}
                  onClick={() => void onApprove(conflict)}
                  className="mt-2 rounded bg-swath-accent px-3 py-2 text-white"
                >
                  Approve proposal
                </button>
              </>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  disabled={busy}
                  onClick={() => void onResolve(conflict, "keep_original")}
                  className="rounded border border-swath-border px-3 py-2 text-swath-text hover:border-swath-accent"
                >
                  Keep existing
                </button>
                <button
                  disabled={busy}
                  onClick={() => void onResolve(conflict, "use_incoming")}
                  className="rounded bg-swath-accent px-3 py-2 text-white"
                >
                  Use incoming
                </button>
              </div>
            )}
          </article>
        ))}
        {error ? (
          <p role="alert" className="mt-3 text-xs text-swath-danger">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}
