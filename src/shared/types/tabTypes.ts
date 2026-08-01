export const paneKinds = ["terminal", "gitManager", "imagePreview", "piAgent"] as const;

export type PaneKind = (typeof paneKinds)[number];
