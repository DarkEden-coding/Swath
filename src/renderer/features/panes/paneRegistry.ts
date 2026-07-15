import type { ComponentType, LazyExoticComponent } from "react";
import type { PaneKind } from "../../../shared/types";
import { getTabTypes } from "../tabTypes/registry";
import type { PaneComponentProps } from "./paneTypes";

interface PaneRegistration {
  label: string;
  Component:
    ComponentType<PaneComponentProps> | LazyExoticComponent<ComponentType<PaneComponentProps>>;
}

function buildPaneRegistry(): Record<PaneKind, PaneRegistration> {
  const entries = getTabTypes().map(
    (t) => [t.kind, { label: t.label, Component: t.Component }] as const,
  );
  return Object.fromEntries(entries) as Record<PaneKind, PaneRegistration>;
}

/** Built from `getTabTypes()` so new tab kinds do not need a separate pane registry edit. */
export const paneRegistry: Record<PaneKind, PaneRegistration> = buildPaneRegistry();

export function getPaneRegistration(kind: PaneKind): PaneRegistration {
  return paneRegistry[kind];
}
