import { useEffect, useState, type PointerEvent as ReactPointerEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import appIcon from "../../../assets/app-icon-64.png";
import { isTauriRuntime } from "../../../platform/runtime";

type WindowAction = "close" | "minimize" | "toggleMaximize";
type ResizeDirection =
  "East" | "North" | "NorthEast" | "NorthWest" | "South" | "SouthEast" | "SouthWest" | "West";

const resizeHandles: ReadonlyArray<{ direction: ResizeDirection; className: string }> = [
  { direction: "North", className: "inset-x-2 top-0 h-1.5 cursor-ns-resize" },
  { direction: "South", className: "inset-x-2 bottom-0 h-1.5 cursor-ns-resize" },
  { direction: "East", className: "inset-y-2 right-0 w-1.5 cursor-ew-resize" },
  { direction: "West", className: "inset-y-2 left-0 w-1.5 cursor-ew-resize" },
  { direction: "NorthEast", className: "right-0 top-0 size-2 cursor-nesw-resize" },
  { direction: "NorthWest", className: "left-0 top-0 size-2 cursor-nwse-resize" },
  { direction: "SouthEast", className: "bottom-0 right-0 size-2 cursor-nwse-resize" },
  { direction: "SouthWest", className: "bottom-0 left-0 size-2 cursor-nesw-resize" },
];

async function runWindowAction(action: WindowAction): Promise<void> {
  if (!isTauriRuntime()) return;

  try {
    await getCurrentWindow()[action]();
  } catch (error) {
    console.error(`Unable to ${action} the application window`, error);
  }
}

function MinimizeIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      <path d="M3 8.5h10" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

function MaximizeIcon({ maximized }: { maximized: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      {maximized ? (
        <>
          <path d="M5.5 5.5V3.75h6.75v6.75H10.5" fill="none" stroke="currentColor" />
          <rect x="3.75" y="5.5" width="6.75" height="6.75" fill="none" stroke="currentColor" />
        </>
      ) : (
        <rect x="3.75" y="3.75" width="8.5" height="8.5" fill="none" stroke="currentColor" />
      )}
    </svg>
  );
}

function CloseIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" className="size-4" aria-hidden>
      <path d="m4 4 8 8m0-8-8 8" fill="none" stroke="currentColor" strokeWidth="1.25" />
    </svg>
  );
}

const controlClass =
  "grid h-full w-11 shrink-0 cursor-default place-items-center border-0 bg-transparent text-swath-muted [-webkit-app-region:no-drag] [app-region:no-drag] hover:bg-swath-panel-2 hover:text-swath-text focus-visible:z-10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-swath-accent focus-visible:outline-offset-[-2px]";

/** Cross-platform application chrome used while Tauri's native decorations are disabled. */
export function WindowTitleBar(): JSX.Element {
  const [maximized, setMaximized] = useState(false);

  const startResize =
    (direction: ResizeDirection) =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== 0 || maximized || !isTauriRuntime()) return;

      event.preventDefault();
      void getCurrentWindow()
        .startResizeDragging(direction)
        .catch((error) => {
          console.error("Unable to start resizing the application window", error);
        });
    };

  useEffect(() => {
    if (!isTauriRuntime()) return;

    const appWindow = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const syncMaximized = async (): Promise<void> => {
      try {
        const nextValue = await appWindow.isMaximized();
        if (!disposed) setMaximized(nextValue);
      } catch (error) {
        console.error("Unable to read the application window state", error);
      }
    };

    void syncMaximized();
    void appWindow
      .onResized(() => void syncMaximized())
      .then((off) => {
        unlisten = off;
        if (disposed) off();
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  const toggleMaximize = (): void => {
    setMaximized((value) => !value);
    void runWindowAction("toggleMaximize");
  };

  return (
    <>
      <header
        className="flex h-10 shrink-0 select-none items-stretch border-b border-swath-border bg-swath-panel [-webkit-app-region:drag] [app-region:drag]"
        data-tauri-drag-region
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          toggleMaximize();
        }}
      >
        <div
          className="pointer-events-none flex min-w-0 flex-1 items-center gap-2.5 px-3"
          data-tauri-drag-region
        >
          <img src={appIcon} alt="" className="size-5 object-contain" draggable={false} />
          <span className="truncate text-xs font-semibold tracking-[0.025em] text-swath-muted">
            Swath
          </span>
        </div>
        <div className="flex shrink-0 items-stretch [-webkit-app-region:no-drag] [app-region:no-drag]">
          <button
            type="button"
            className={controlClass}
            aria-label="Minimize window"
            title="Minimize"
            onClick={() => void runWindowAction("minimize")}
          >
            <MinimizeIcon />
          </button>
          <button
            type="button"
            className={controlClass}
            aria-label={maximized ? "Restore window" : "Maximize window"}
            title={maximized ? "Restore" : "Maximize"}
            onClick={toggleMaximize}
          >
            <MaximizeIcon maximized={maximized} />
          </button>
          <button
            type="button"
            className={`${controlClass} hover:bg-swath-danger hover:text-white`}
            aria-label="Close window"
            title="Close"
            onClick={() => void runWindowAction("close")}
          >
            <CloseIcon />
          </button>
        </div>
      </header>
      {resizeHandles.map(({ direction, className }) => (
        <div
          key={direction}
          aria-hidden
          className={`fixed z-[100] ${className} [-webkit-app-region:no-drag] [app-region:no-drag]`}
          onPointerDown={startResize(direction)}
        />
      ))}
    </>
  );
}
