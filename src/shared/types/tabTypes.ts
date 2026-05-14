export const paneKinds = ["terminal"] as const;

export type PaneKind = (typeof paneKinds)[number];
