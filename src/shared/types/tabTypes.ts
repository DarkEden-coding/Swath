export const paneKinds = ["terminal", "gitManager"] as const;

export type PaneKind = (typeof paneKinds)[number];
