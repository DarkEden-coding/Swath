import type { ComponentType } from "react";
import type { PaneKind } from "../../../shared/types";
import { TerminalPane } from "../terminal/components/TerminalPane";
import type { PaneComponentProps } from "./paneTypes";

interface PaneRegistration {
  label: string;
  Component: ComponentType<PaneComponentProps>;
}

export const paneRegistry: Record<PaneKind, PaneRegistration> = {
  terminal: {
    label: "Terminal",
    Component: TerminalPane,
  },
};

export function getPaneRegistration(kind: PaneKind): PaneRegistration {
  return paneRegistry[kind];
}
