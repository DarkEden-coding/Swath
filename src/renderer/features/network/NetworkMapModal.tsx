import { useEffect, useMemo, useState } from "react";
import type { Network, NetworkMember } from "../../../shared/types";
import { useTaskStore } from "../../state/taskStore";
import { IconClose } from "../shell/icons";
import { usePiActivityStore } from "../tabTypes/piAgent/piActivity";
import { buildNetworkGraph, type NetworkGraphNode } from "./networkGraph";

interface NetworkMapModalProps {
  open: boolean;
  onClose: () => void;
}

const stateColor = {
  running: "#58a6ff",
  available: "#3fb950",
  offline: "#d29922",
} as const;

function stateLabel(node: NetworkGraphNode): string {
  if (node.state === "running")
    return `${node.running} agent${node.running === 1 ? "" : "s"} running`;
  return node.state === "available" ? "Available" : "Unreachable";
}

export function NetworkMapModal({ open, onClose }: NetworkMapModalProps): JSX.Element | null {
  const {
    catalog,
    devices,
    members: catalogMembers,
    networkId,
    refresh: refreshCatalog,
  } = useTaskStore();
  const activity = usePiActivityStore((state) => state.activity);
  const [network, setNetwork] = useState<Network | null>(null);
  const [members, setMembers] = useState<NetworkMember[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose, open]);

  useEffect(() => {
    if (!open || !networkId) return;
    let active = true;
    const refresh = async () => {
      try {
        const [snapshot, nextMembers] = await Promise.all([
          window.swath.network.current(),
          window.swath.network.membership(networkId),
          refreshCatalog(),
        ]);
        if (!active) return;
        setNetwork(snapshot?.network ?? null);
        setMembers(nextMembers);
        setError(null);
      } catch (cause) {
        if (active)
          setError(cause instanceof Error ? cause.message : "Could not read network state");
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [networkId, open, refreshCatalog]);

  const authoritativeMembers = useMemo(() => {
    const live = new Map(members.map((member) => [member.deviceId, member]));
    return devices.map((device) => {
      const catalogMember = catalogMembers.find((member) => member.deviceId === device.id);
      const observed = live.get(device.id);
      return {
        deviceId: device.id,
        voter: catalogMember?.voter ?? false,
        healthy: observed?.healthy ?? catalogMember?.healthy ?? false,
      };
    });
  }, [catalogMembers, devices, members]);
  const graph = useMemo(
    () => buildNetworkGraph(devices, authoritativeMembers, catalog.tasks, catalog.panes, activity),
    [activity, authoritativeMembers, catalog.panes, catalog.tasks, devices],
  );
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[190] grid place-items-center bg-black/70 p-5 backdrop-blur-sm"
      onMouseDown={onClose}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="network-map-title"
        className="flex max-h-[min(850px,92vh)] w-[min(1040px,94vw)] flex-col overflow-hidden rounded-2xl border border-swath-border bg-[#11161e] shadow-[0_28px_90px_rgba(0,0,0,0.65)]"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-6 border-b border-swath-border px-6 py-5">
          <div>
            <div className="mb-1 flex items-center gap-2.5">
              <span className="size-2.5 rounded-full bg-swath-accent shadow-[0_0_14px_rgba(56,139,253,0.75)]" />
              <h2 id="network-map-title" className="text-xl font-semibold text-swath-text">
                {network?.name ?? "Swath network"}
              </h2>
            </div>
            <p className="text-sm text-swath-muted">
              Devices connected through the shared server · updates every 5 seconds
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Close network map"
              onClick={onClose}
              className="grid size-9 place-items-center rounded-lg text-swath-muted hover:bg-swath-panel-2 hover:text-swath-text"
            >
              <IconClose width={18} height={18} />
            </button>
          </div>
        </header>

        <div className="overflow-y-auto p-5">
          {error ? (
            <div className="mb-4 rounded-lg border border-[rgba(248,81,73,0.35)] bg-[rgba(248,81,73,0.08)] px-4 py-2 text-sm text-swath-danger">
              {error}
            </div>
          ) : null}
          <div className="relative overflow-hidden rounded-xl border border-swath-border bg-[radial-gradient(circle_at_center,rgba(56,139,253,0.09),transparent_58%)]">
            <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(139,148,158,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(139,148,158,0.12)_1px,transparent_1px)] [background-size:28px_28px]" />
            {graph.nodes.length ? (
              <svg
                viewBox="0 0 800 440"
                className="relative block h-[min(48vh,440px)] w-full"
                role="img"
                aria-label="Device connection graph"
              >
                <defs>
                  <filter id="network-glow" x="-100%" y="-100%" width="300%" height="300%">
                    <feGaussianBlur stdDeviation="5" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>
                {graph.edges.map((edge) => (
                  <line
                    key={`${edge.source.device.id}:${edge.target.device.id}`}
                    x1={edge.source.x}
                    y1={edge.source.y}
                    x2={edge.target.x}
                    y2={edge.target.y}
                    stroke={edge.healthy ? "rgba(56,139,253,0.48)" : "rgba(139,148,158,0.22)"}
                    strokeWidth={edge.healthy ? 2 : 1.25}
                    strokeDasharray={edge.healthy ? undefined : "6 7"}
                  />
                ))}
                {graph.nodes.map((node) => {
                  const color = stateColor[node.state];
                  return (
                    <g key={node.device.id} transform={`translate(${node.x} ${node.y})`}>
                      <rect
                        x="-100"
                        y="-39"
                        width="200"
                        height="78"
                        rx="13"
                        fill="rgba(13,17,23,0.95)"
                        stroke={color}
                        strokeWidth="2"
                        filter={node.state === "running" ? "url(#network-glow)" : undefined}
                      />
                      <circle r="4" cx="-82" cy="-22" fill={color} />
                      <text
                        x="-70"
                        y="-18"
                        fill="#8b949e"
                        fontSize="8.5"
                        fontWeight="700"
                        letterSpacing=".8"
                      >
                        {node.member?.voter ? "CATALOG SERVER" : "CONNECTED DEVICE"}
                      </text>
                      <text x="-82" y="6" fill="#d0d7de" fontSize="12.5" fontWeight="600">
                        {node.device.displayName}
                      </text>
                      <text x="-82" y="25" fill={color} fontSize="10.5">
                        {stateLabel(node)}
                      </text>
                    </g>
                  );
                })}
              </svg>
            ) : (
              <div className="grid h-72 place-items-center text-sm text-swath-muted">
                No enrolled devices
              </div>
            )}
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {graph.nodes.map((node) => (
              <div
                key={node.device.id}
                className="rounded-xl border border-swath-border bg-swath-panel px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-semibold text-swath-text">
                    {node.device.displayName}
                  </span>
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: stateColor[node.state] }}
                  />
                </div>
                <div className="mt-1 truncate font-mono text-[11px] text-swath-muted-2">
                  {node.device.hostname}
                </div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-swath-muted">
                  <span>{stateLabel(node)}</span>
                  <span>
                    {node.activeTasks} active task{node.activeTasks === 1 ? "" : "s"}
                  </span>
                  <span>{node.member?.voter ? "Catalog server" : "Connected device"}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
