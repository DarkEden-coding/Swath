import { lazy } from "react";
import type { AppSettings, PaneLeaf, WorkspaceView } from "../../../../shared/types";
import { createPaneNode } from "../../../domain/layout/layoutTree";
import { createId } from "../../../utils/ids";
import { websiteAddressFrom } from "./websiteAddress";
import type { TabTypeRegistration } from "../types";

const WebsitePane = lazy(() =>
  import("./WebsitePane").then((module) => ({ default: module.WebsitePane })),
);

/** Creates metadata for a website pane, retaining its address in persisted pane metadata. */
export function createWebsitePaneMeta(
  settings: AppSettings,
  _cwd?: string,
  address = "",
): Partial<Omit<PaneLeaf, "type" | "id">> {
  void settings;
  const website = websiteAddressFrom(address);
  return {
    kind: "website",
    title: website?.title ?? "Website",
    metadata: {
      title: website?.title ?? "Website",
      ...(website ? { websiteAddress: website.url } : {}),
    },
  };
}

/** Creates a workspace view whose root pane embeds a website. */
export function createWebsiteView(
  title = "Website",
  cwd?: string,
  settings?: AppSettings,
  address = "",
): WorkspaceView {
  const pane = createPaneNode(
    undefined,
    settings ? createWebsitePaneMeta(settings, cwd, address) : { kind: "website" },
  );
  return {
    id: createId("view"),
    type: "workspace-view",
    title,
    layout: pane,
    activePaneId: pane.id,
  };
}

export const websiteTabType: TabTypeRegistration = {
  kind: "website",
  label: "Website",
  Component: WebsitePane,
  createPaneMeta: createWebsitePaneMeta,
  createView: (title, cwd, settings) => createWebsiteView(title, cwd, settings),
};
