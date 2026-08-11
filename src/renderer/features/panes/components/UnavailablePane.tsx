/**
 * Last-resort rendering for a pane whose kind this build no longer ships.
 *
 * Stored layouts outlive the tab types they name: removing a tab type leaves every config that
 * referenced it pointing at nothing. `sanitizeConfig` strips those panes on load, so this should
 * normally never render — it exists so a kind that slips through (a config written by a newer
 * build, a kind removed while running) degrades to a closeable placeholder instead of throwing
 * out of render and tripping the critical error overlay.
 */

import type { PaneKind } from "../../../../shared/types";
import * as appActions from "../../../app/appActions";
import { collectPaneIds } from "../../../domain/layout/layoutTree";
import { PaneFrame } from "./PaneFrame";
import type { PaneComponentProps } from "../paneTypes";

const buttonClass =
  "cursor-pointer rounded-md border border-swath-border bg-transparent px-2.5 py-1 text-swath-text hover:border-swath-border-strong hover:bg-swath-panel";

export function UnavailablePane({ workspace, view, pane }: PaneComponentProps): JSX.Element {
  const solePane = collectPaneIds(view.layout).length <= 1;
  const soleView = workspace.views.length <= 1;

  const splitWith = (direction: "vertical" | "horizontal", kind: PaneKind = "terminal"): void =>
    appActions.splitPane(workspace.id, view.id, pane.id, direction, kind);

  /**
   * Closing the last pane of a view is a no-op, and so is closing the last view of a workspace —
   * so when this pane is both, put a terminal beside it first and then close it. That leaves a
   * usable workspace rather than an empty one.
   */
  const remove = (): void => {
    if (solePane && soleView) {
      splitWith("vertical");
      appActions.closePane(workspace.id, view.id, pane.id);
      return;
    }
    if (solePane) appActions.closeView(workspace.id, view.id);
    else appActions.closePane(workspace.id, view.id, pane.id);
  };

  return (
    <PaneFrame
      active={view.activePaneId === pane.id}
      title={pane.title ?? "Unavailable"}
      onActivate={() => appActions.setActivePane(workspace.id, view.id, pane.id)}
      onSplitRight={(kind) => splitWith("vertical", kind)}
      onSplitDown={(kind) => splitWith("horizontal", kind)}
      onClose={remove}
    >
      <div className="grid h-full min-h-0 place-items-center p-4 text-center text-[12px] text-swath-muted">
        <div className="flex max-w-[420px] flex-col items-center gap-3">
          <div>
            This tab type (<span className="font-mono text-swath-text">{String(pane.kind)}</span>)
            is no longer available in this version of Swath.
          </div>
          <div className="flex gap-2">
            <button type="button" className={buttonClass} onClick={remove}>
              {solePane && !soleView ? "Close tab" : "Close pane"}
            </button>
            <button type="button" className={buttonClass} onClick={() => splitWith("vertical")}>
              Open a terminal here
            </button>
          </div>
        </div>
      </div>
    </PaneFrame>
  );
}
