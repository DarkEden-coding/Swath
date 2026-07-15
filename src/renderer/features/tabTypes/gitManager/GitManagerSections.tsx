import type { RefObject } from "react";
import type { GitLogEntry, GitPathEntry } from "../../../services/gitClient";
import {
  buildCommitGraphLayout,
  CommitGraphSvg,
  COMMIT_GRAPH_CELL_W,
  COMMIT_GRAPH_ROW_H,
} from "./CommitGraphSvg";
import {
  extAccentClass,
  refBadgeClass,
  refTokens,
  simplifyRefLabel,
  statusLetterClass,
} from "./gitManagerUtils";
import { IconChevronDown, IconCopy, IconMoreVertical } from "../../shell/icons";

export type FileMenu = { path: string; kind: "staged" | "unstaged" } | null;
export interface ChangesViewModel {
  open: boolean;
  busy: boolean;
  staged: GitPathEntry[];
  unstaged: GitPathEntry[];
  paths: string[];
  selected: Set<string>;
  fileMenu: FileMenu;
  fileMenuRef: RefObject<HTMLDivElement | null>;
  toggleOpen(): void;
  togglePath(path: string): void;
  toggleAll(): void;
  setFileMenu(menu: FileMenu): void;
  stage(paths?: string[]): void;
  unstage(paths: string[]): void;
  discard(paths: string[]): void;
}
const iconBtn =
  "grid size-8 shrink-0 place-items-center rounded-md border border-transparent text-swath-muted hover:border-swath-border hover:bg-swath-panel-2 hover:text-swath-text disabled:opacity-40";
const headerBtn =
  "flex w-full cursor-pointer items-center gap-2 border-0 bg-transparent py-1.5 pl-1 pr-0 text-left hover:bg-swath-panel/80";
const ghost =
  "inline-flex items-center justify-center rounded border border-swath-border bg-swath-panel-2 px-2.5 py-1.5 text-[12px] disabled:opacity-40";

/** Staged and working-tree change lists, including their contextual actions. */
export function GitChangesSection({ vm }: { vm: ChangesViewModel }): JSX.Element {
  const allSelected = vm.paths.length > 0 && vm.paths.every((p) => vm.selected.has(p));
  const menu = (path: string, kind: "staged" | "unstaged") =>
    vm.fileMenu?.path === path && vm.fileMenu.kind === kind;
  return (
    <div className="mb-1 border-t border-swath-border/60 pt-1">
      <button type="button" className={headerBtn} onClick={vm.toggleOpen}>
        <IconChevronDown
          width={14}
          height={14}
          className={`transition-transform ${vm.open ? "" : "-rotate-90"}`}
        />
        <span className="text-[11px] font-semibold uppercase text-swath-muted">Changes</span>
        <span className="rounded bg-swath-panel-2 px-1.5 text-[10px]">
          {vm.staged.length + vm.paths.length}
        </span>
      </button>
      {vm.open && (
        <div className="pb-2 pl-1">
          <div className="mb-2 mt-1">
            <div className="mb-1 text-[10px] font-semibold uppercase text-swath-muted-2">
              Staged ({vm.staged.length})
            </div>
            {vm.staged.length === 0 ? (
              <p className="py-1 pl-1 text-[12px] text-swath-muted">No staged changes.</p>
            ) : (
              <ul className="m-0 list-none rounded border border-swath-border/50 p-0">
                {vm.staged.map((e) => (
                  <li
                    key={e.path}
                    className="flex items-center gap-2 border-b border-swath-border/30 py-1.5 pl-2 pr-1 last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked
                      readOnly
                      disabled={vm.busy}
                      title="Click to unstage"
                      onClick={() => vm.unstage([e.path])}
                    />
                    <span className={`size-1.5 rounded-full ${extAccentClass(e.path)}`} />
                    <span
                      className={`w-4 font-mono text-[11px] ${statusLetterClass(true, e.status)}`}
                    >
                      {e.status}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{e.path}</span>
                    <div className="relative">
                      <button
                        className={iconBtn}
                        title="File actions"
                        onClick={() =>
                          vm.setFileMenu(
                            menu(e.path, "staged") ? null : { path: e.path, kind: "staged" },
                          )
                        }
                      >
                        <IconMoreVertical width={14} />
                      </button>
                      {menu(e.path, "staged") && (
                        <div
                          ref={vm.fileMenuRef}
                          className="absolute right-0 top-full z-[70] min-w-[140px] rounded border border-swath-border bg-swath-panel py-1"
                        >
                          <button
                            className="w-full px-3 py-1.5 text-left text-[12px]"
                            onClick={() => vm.unstage([e.path])}
                          >
                            Unstage
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div className="mb-1 flex justify-between">
            <span className="text-[10px] font-semibold uppercase text-swath-muted-2">
              Unstaged ({vm.paths.length})
            </span>
            {vm.paths.length > 0 && (
              <div className="flex gap-2">
                <button
                  className="text-[11px] text-swath-accent"
                  disabled={vm.busy}
                  onClick={vm.toggleAll}
                >
                  {allSelected ? "Deselect all" : "Select all"}
                </button>
                <button
                  className="text-[11px] text-swath-accent"
                  disabled={vm.busy}
                  onClick={() => vm.stage(vm.paths)}
                >
                  Stage all
                </button>
              </div>
            )}
          </div>
          {vm.paths.length === 0 ? (
            <p className="py-1 pl-1 text-[12px] text-swath-muted">No pending changes.</p>
          ) : (
            <ul className="m-0 list-none rounded border border-swath-border/50 p-0">
              {vm.paths.map((path) => {
                const e = vm.unstaged.find((x) => x.path === path);
                const letter = e?.status ?? "?";
                return (
                  <li
                    key={path}
                    className="flex items-center gap-2 border-b border-swath-border/30 py-1.5 pl-2 pr-1 last:border-0"
                  >
                    <input
                      type="checkbox"
                      checked={vm.selected.has(path)}
                      disabled={vm.busy}
                      aria-label={`Select ${path}`}
                      onChange={() => vm.togglePath(path)}
                    />
                    <span className={`size-1.5 rounded-full ${extAccentClass(path)}`} />
                    <span
                      className={`w-4 font-mono text-[11px] ${statusLetterClass(false, letter)}`}
                    >
                      {letter}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{path}</span>
                    <button disabled={vm.busy} onClick={() => vm.stage([path])}>
                      Stage
                    </button>
                    <div className="relative">
                      <button
                        className={iconBtn}
                        title="File actions"
                        onClick={() =>
                          vm.setFileMenu(menu(path, "unstaged") ? null : { path, kind: "unstaged" })
                        }
                      >
                        <IconMoreVertical width={14} />
                      </button>
                      {menu(path, "unstaged") && (
                        <div
                          ref={vm.fileMenuRef}
                          className="absolute right-0 top-full z-[70] min-w-[160px] rounded border border-swath-border bg-swath-panel py-1"
                        >
                          <button
                            className="w-full px-3 py-1.5 text-left"
                            onClick={() => vm.stage([path])}
                          >
                            Stage
                          </button>
                          <button
                            className="w-full px-3 py-1.5 text-left text-swath-warn"
                            onClick={() => vm.discard([path])}
                          >
                            Discard changes
                          </button>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
          <button
            className={`${ghost} mt-2`}
            disabled={vm.busy || vm.selected.size === 0}
            onClick={() => vm.stage()}
          >
            Stage selected ({vm.selected.size})
          </button>
        </div>
      )}
    </div>
  );
}

/** Graph-backed commit history presentation. */
export function GitHistorySection({
  commits,
  open,
  toggleOpen,
  copyHash,
}: {
  commits: GitLogEntry[];
  open: boolean;
  toggleOpen(): void;
  copyHash(hash: string): void;
}): JSX.Element {
  const layout = buildCommitGraphLayout(commits);
  const width = layout.cols * COMMIT_GRAPH_CELL_W;
  return (
    <div className="border-t border-swath-border/60 pt-1">
      <button className={headerBtn} onClick={toggleOpen}>
        <IconChevronDown width={14} className={open ? "" : "-rotate-90"} />
        <span className="text-[11px] font-semibold uppercase text-swath-muted">Commits</span>
        <span className="text-[10px]">{commits.length}</span>
      </button>
      {open && (
        <div className="mt-1 rounded border border-swath-border/50">
          {commits.length === 0 ? (
            <p className="px-2 py-3 text-swath-muted">No commits yet.</p>
          ) : (
            <div
              className="max-h-[min(420px,45vh)] overflow-y-auto"
              style={{
                display: "grid",
                gridTemplateColumns: `${width}px minmax(0,1fr)`,
                gridTemplateRows: `repeat(${commits.length},${COMMIT_GRAPH_ROW_H}px)`,
              }}
            >
              <div style={{ gridColumn: 1, gridRow: `1 / span ${commits.length}` }}>
                <CommitGraphSvg
                  layout={layout}
                  rowHeight={COMMIT_GRAPH_ROW_H}
                  cellWidth={COMMIT_GRAPH_CELL_W}
                />
              </div>
              {commits.map((c, i) => (
                <div
                  key={`${c.hash}-${i}`}
                  style={{ gridColumn: 2, gridRow: i + 1 }}
                  className="flex min-w-0 items-center gap-2 overflow-hidden border-b px-2"
                >
                  <div className="min-w-0 flex-1">
                    {refTokens(c.refs).map((r) => (
                      <span
                        key={r}
                        className={`mr-1 rounded border px-1 text-[10px] ${refBadgeClass(r)}`}
                      >
                        {simplifyRefLabel(r)}
                      </span>
                    ))}
                    <div className="truncate font-medium">{c.subject}</div>
                    <div className="truncate text-[11px] text-swath-muted">
                      {c.author} · {c.date}
                    </div>
                  </div>
                  <code className="text-[10px]">{c.short}</code>
                  <button
                    className={iconBtn}
                    title="Copy full hash"
                    onClick={() => copyHash(c.hash)}
                  >
                    <IconCopy width={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
