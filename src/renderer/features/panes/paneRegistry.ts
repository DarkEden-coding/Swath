import type { ComponentType, LazyExoticComponent } from "react";
import type { PaneKind } from "../../../shared/types";
import { getTabType } from "../tabTypes/registry";
import type { PaneComponentProps } from "./paneTypes";

interface PaneRegistration {
  label: string;
  Component: ComponentType<PaneComponentProps> | LazyExoticComponent<ComponentType<PaneComponentProps>>;
}

export const paneRegistry: Record<PaneKind, PaneRegistration> = {
  terminal: {
    label: getTabType("terminal").label,
    Component: getTabType("terminal").Component,
  },
};

export function getPaneRegistration(kind: PaneKind): PaneRegistration {
  return paneRegistry[kind];
}
