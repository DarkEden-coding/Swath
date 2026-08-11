export const paneKinds = ["terminal", "gitManager", "piAgent"] as const;

export type PaneKind = (typeof paneKinds)[number];
