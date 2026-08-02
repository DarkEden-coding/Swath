import { useEffect, useState } from "react";
import * as appActions from "../../../app/appActions";
import { findPane } from "../../../domain/layout/layoutTree";
import { imageClient } from "../../../services/imageClient";
import { useUiStore } from "../../../state/uiStore";
import { PaneFrame } from "../../panes/components/PaneFrame";
import type { PaneComponentProps } from "../../panes/paneTypes";

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const ZOOM_STEP = 0.25;

type FetchedImage =
  | { requestPath: string; status: "ready"; path: string; title: string; objectUrl: string }
  | { requestPath: string; status: "error"; message: string };

type LoadState =
  | { status: "empty" }
  | { status: "loading"; path: string }
  | { status: "ready"; path: string; title: string; objectUrl: string }
  | { status: "error"; path: string; message: string };

/** Builds a `file://` URL suitable for `openExternal` on local paths. */
function fileUrlFromPath(path: string): string {
  if (path.startsWith("file:")) return path;
  const normalized = path.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized)) return `file:///${normalized}`;
  return `file://${normalized.startsWith("/") ? normalized : `/${normalized}`}`;
}

/**
 * Path-metadata image preview pane. Loads bytes via host RPC on demand and never
 * persists image payloads in workspace config.
 */
export function ImagePreviewPane({ workspace, view, pane }: PaneComponentProps): JSX.Element {
  const activePaneId = useUiStore((state) => state.activePaneId);
  const paneId = pane.id;
  const paneMeta = findPane(view.layout, paneId);
  const imagePath = (paneMeta?.metadata?.imagePath ?? "").trim();
  const imageTitle =
    paneMeta?.metadata?.imageTitle ??
    paneMeta?.title ??
    paneMeta?.metadata?.title ??
    "Image Preview";
  const cwd = (paneMeta?.cwd ?? paneMeta?.metadata?.cwd ?? workspace.path).trim() || workspace.path;
  const isActive = activePaneId === paneId || view.activePaneId === paneId;

  const [fetched, setFetched] = useState<FetchedImage | null>(null);
  const [fit, setFit] = useState(true);
  const [zoom, setZoom] = useState(1);

  useEffect(() => {
    if (!imagePath) return;

    let cancelled = false;
    void imageClient
      .load(imagePath, cwd)
      .then((result) => {
        if (cancelled) return;
        const objectUrl = `data:${result.mimeType};base64,${result.dataBase64}`;
        setFetched({
          requestPath: imagePath,
          status: "ready",
          path: result.path,
          title: result.title || imageTitle,
          objectUrl,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFetched({
          requestPath: imagePath,
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [cwd, imagePath, imageTitle]);

  const loadState: LoadState = !imagePath
    ? { status: "empty" }
    : fetched && fetched.requestPath === imagePath
      ? fetched.status === "ready"
        ? {
            status: "ready",
            path: fetched.path,
            title: fetched.title,
            objectUrl: fetched.objectUrl,
          }
        : { status: "error", path: imagePath, message: fetched.message }
      : { status: "loading", path: imagePath };

  const headerTitle =
    loadState.status === "ready"
      ? loadState.title
      : imageTitle.trim()
        ? imageTitle
        : "Image Preview";

  const openExternal = (): void => {
    const path = loadState.status === "ready" ? loadState.path : imagePath;
    if (!path) return;
    void window.swath.browser.openExternal(fileUrlFromPath(path));
  };

  const adjustZoom = (delta: number): void => {
    setFit(false);
    setZoom((current) =>
      Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Number((current + delta).toFixed(2)))),
    );
  };

  return (
    <PaneFrame
      active={isActive}
      title={headerTitle}
      statusClass={loadState.status === "error" ? "exited" : "running"}
      onActivate={() => appActions.setActivePane(workspace.id, view.id, paneId)}
      onSplitRight={(kind) => appActions.splitPane(workspace.id, view.id, paneId, "vertical", kind)}
      onSplitDown={(kind) =>
        appActions.splitPane(workspace.id, view.id, paneId, "horizontal", kind)
      }
      onClose={() => appActions.closePane(workspace.id, view.id, paneId)}
    >
      <div className="flex h-full min-h-0 flex-col bg-[#0d1117]">
        <div className="flex shrink-0 items-center gap-2 border-b border-swath-border bg-swath-panel px-2.5 py-1.5">
          <button
            type="button"
            className={`rounded border px-2 py-0.5 text-[12px] ${fit ? "border-swath-accent bg-[#1f2a37] text-swath-text" : "border-swath-border bg-transparent text-swath-muted hover:border-swath-border-strong hover:text-swath-text"}`}
            onClick={() => {
              setFit(true);
              setZoom(1);
            }}
          >
            Fit
          </button>
          <button
            type="button"
            className="rounded border border-swath-border bg-transparent px-2 py-0.5 text-[12px] text-swath-muted hover:border-swath-border-strong hover:text-swath-text"
            onClick={() => adjustZoom(-ZOOM_STEP)}
            disabled={fit && zoom <= 1}
          >
            −
          </button>
          <span className="min-w-[3.5rem] text-center font-mono text-[11px] text-swath-muted">
            {fit ? "Fit" : `${Math.round(zoom * 100)}%`}
          </span>
          <button
            type="button"
            className="rounded border border-swath-border bg-transparent px-2 py-0.5 text-[12px] text-swath-muted hover:border-swath-border-strong hover:text-swath-text"
            onClick={() => adjustZoom(ZOOM_STEP)}
          >
            +
          </button>
          <button
            type="button"
            className="ml-auto rounded border border-swath-border bg-transparent px-2 py-0.5 text-[12px] text-swath-muted hover:border-swath-border-strong hover:text-swath-text disabled:opacity-40"
            onClick={openExternal}
            disabled={!imagePath}
          >
            Open external
          </button>
        </div>
        <div className="relative min-h-0 flex-1 overflow-auto">
          {loadState.status === "empty" ? (
            <div className="grid h-full place-items-center px-6 text-center text-sm text-swath-muted">
              No image selected. Drop an image into a terminal or use the pi image tool.
            </div>
          ) : null}
          {loadState.status === "loading" ? (
            <div className="grid h-full place-items-center px-6 text-center text-sm text-swath-muted">
              Loading image…
            </div>
          ) : null}
          {loadState.status === "error" ? (
            <div className="grid h-full place-items-center px-6 text-center text-sm text-swath-danger">
              <div>
                <div className="mb-1 font-medium text-swath-text">Unable to preview image</div>
                <div className="font-mono text-[12px] text-swath-muted">{loadState.message}</div>
              </div>
            </div>
          ) : null}
          {loadState.status === "ready" ? (
            <div
              className={
                fit
                  ? "h-full w-full"
                  : "flex min-h-full min-w-full items-center justify-center p-4"
              }
            >
              {/* Fit scales by the smaller axis and crops the overflow, so the pane is always
                  filled edge to edge; zooming switches back to the whole, scrollable image. */}
              <img
                src={loadState.objectUrl}
                alt={loadState.title}
                className={fit ? "h-full w-full object-cover" : "max-w-none object-contain"}
                style={fit ? undefined : { width: `${zoom * 100}%`, height: "auto" }}
                draggable={false}
              />
            </div>
          ) : null}
        </div>
      </div>
    </PaneFrame>
  );
}
