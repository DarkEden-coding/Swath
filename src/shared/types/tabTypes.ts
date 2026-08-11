export const paneKinds = [
  "terminal",
  "gitManager",
  "imagePreview",
  "fileBrowser",
  "piAgent",
] as const;

export type PaneKind = (typeof paneKinds)[number];
