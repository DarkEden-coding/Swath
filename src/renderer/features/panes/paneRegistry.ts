import type { ComponentType, LazyExoticComponent } from "react";
import type { PaneKind } from "../../../shared/types";
import { isPaneKind } from "../../../shared/types";
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

/**
 * Returns undefined for a kind with no registration — a pane kind removed by an update can still
 * be named by a stored layout, and a missing registration must not throw during render.
 */
export function getPaneRegistration(kind: PaneKind): PaneRegistration | undefined {
  return isPaneKind(kind) ? paneRegistry[kind] : undefined;
}
