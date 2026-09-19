import { useCallback, useEffect, useState } from "react";
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

  const check = useCallback(async (): Promise<CatalogSnapshot | null> => {
    setError(null);
    try {
      const current = await window.swath.network.current();
      setSnapshot(current);
      if (current) {
        const unresolved = (await window.swath.migration.conflicts()).filter(
          (item) => item.state !== "resolved",
        );
        setConflicts(unresolved);
        const status = await window.swath.migration.status();
        if (status.needsMigration) {
          const preview = await window.swath.migration.preview(
            status.operationId ?? "legacy-v2-import",
          );
          setMigration(preview);
          setMappings(preview.suggestedMappings);
        } else onReady(current);
      }
      return current;
    } catch (cause) {
      setSnapshot(null);
      setError(cause instanceof Error ? cause.message : "Could not check network setup");
      return null;
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
      onReady(await window.swath.network.initialize(name.trim() || "Swath"));
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
    if (snapshot) onReady(snapshot);
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
      setError(cause instanceof Error ? cause.message : "Migration could not be confirmed");
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
        onResolve={async (conflict) => {
          setBusy(true);
          try {
            await window.swath.migration.ensureResolutionJob(conflict.conflictId);
            await check();
          } catch (cause) {
            setError(cause instanceof Error ? cause.message : "Could not create review job");
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
    return (
      <main className="grid h-full place-items-center bg-swath-bg p-6">
        <section className="w-full max-w-2xl rounded-lg border border-swath-border bg-swath-panel p-6 shadow-swath">
          <h1 className="text-lg font-semibold text-swath-text">Import legacy workspaces</h1>
          <p className="mt-2 text-sm text-swath-muted">
            Review the immutable source fingerprint <code>{migration.sourceFingerprint}</code>.
            Backup: {migration.backupPath}
          </p>
          <div className="mt-4 space-y-3">
            {migration.workspaces.map((workspace, index) => (
              <div
                key={workspace.id}
                className="rounded border border-swath-border p-3 text-sm text-swath-text"
              >
                <div>
                  {workspace.name} — {workspace.git}; {workspace.panes} panes;{" "}
                  {workspace.piSessions.length} Pi sessions
                </div>
                <div className="text-xs text-swath-muted">{workspace.repositoryIdentity}</div>
                <input
                  aria-label={`${workspace.name} project mapping`}
                  value={mappings[index]?.projectKey ?? ""}
                  onChange={(event) =>
                    setMappings((current) =>
                      current.map((mapping, i) =>
                        i === index ? { ...mapping, projectKey: event.target.value } : mapping,
                      ),
                    )
                  }
                  className="mt-2 w-full rounded border border-swath-border bg-swath-bg p-1"
                />
              </div>
            ))}
          </div>
          <div className="mt-4 flex gap-2">
            <button
              disabled={busy}
              onClick={() => void confirmMigration()}
              className="rounded bg-swath-accent px-3 py-2 text-sm text-white"
            >
              Approve import
            </button>
            <button
              disabled={busy}
              onClick={() => void exportBackup()}
              className="rounded px-3 py-2 text-sm text-swath-muted underline"
            >
              Export backup instead
            </button>
          </div>
          {error ? (
            <p role="alert" className="mt-3 text-xs text-swath-danger">
              {error}
            </p>
          ) : null}
        </section>
      </main>
    );
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
  onResolve(conflict: MigrationConflict): Promise<void>;
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
              <button
                disabled={busy}
                onClick={() => void onResolve(conflict)}
                className="mt-2 rounded border px-3 py-2"
              >
                {conflict.state === "manual_required" ? "Manual review required" : "Open review"}
              </button>
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
