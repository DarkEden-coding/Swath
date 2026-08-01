export const paneKinds = ["terminal", "gitManager", "imagePreview"] as const;

export type PaneKind = (typeof paneKinds)[number];
