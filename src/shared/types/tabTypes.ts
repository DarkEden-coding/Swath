export const paneKinds = ["terminal", "gitManager", "fileBrowser", "piAgent"] as const;

export type PaneKind = (typeof paneKinds)[number];

/**
 * Persisted configuration can name a pane kind this build no longer ships — a tab type removed by
 * an update outlives the config that referenced it. Every lookup keyed by kind has to survive that,
 * so guard reads of stored kinds with this rather than trusting the declared type.
 */
export function isPaneKind(value: unknown): value is PaneKind {
  return typeof value === "string" && (paneKinds as readonly string[]).includes(value);
}
