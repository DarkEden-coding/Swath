export const paneKinds = ["terminal", "gitManager", "fileBrowser", "piAgent"] as const;

export type PaneKind = (typeof paneKinds)[number];
