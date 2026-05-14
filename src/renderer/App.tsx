import { Suspense, lazy, useEffect } from "react";
import * as appActions from "./app/appActions";
import { runAppCommand } from "./app/commandRegistry";
import { useAppBootstrap } from "./app/useAppBootstrap";
import { EmptyState } from "./features/shell/components/EmptyState";
import { Sidebar } from "./features/shell/components/Sidebar";
import { StatusBar } from "./features/shell/components/StatusBar";
import { SettingsModal } from "./features/settings/components/SettingsModal";
import { useConfigStore } from "./state/configStore";
import { useUiStore } from "./state/uiStore";

const TerminalWorkspace = lazy(() =>
  import("./features/shell/components/TerminalWorkspace").then((module) => ({ default: module.TerminalWorkspace })),
);

const bootScreenClass =
  "grid h-full w-full place-items-center bg-[radial-gradient(circle_at_50%_40%,#161b22,#0d1117_58%)] text-swath-muted [-webkit-app-region:no-drag] [app-region:no-drag]";

export function App(): JSX.Element {
  const config = useConfigStore((state) => state.config);
  const loaded = useConfigStore((state) => state.loaded);
  const activePaneId = useUiStore((state) => state.activePaneId);
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebarCollapsed = useUiStore((state) => state.toggleSidebarCollapsed);

  useAppBootstrap();

  const activeWorkspace = config?.workspaces.find((workspace) => workspace.id === config.activeWorkspaceId) ?? null;
  const activeView =
    activeWorkspace?.views.find((tab) => tab.id === activeWorkspace.activeViewId) ?? activeWorkspace?.views[0] ?? null;

  useEffect(() => {
    document.documentElement.classList.add(`platform-${window.swath.platform}`);
  }, []);

  useEffect(() => {
    const offCommand = window.swath.app.onCommand((command) => {
      runAppCommand(command, {
        activeWorkspace,
        activeView,
        activePaneId,
        addWorkspaceFromFolder: appActions.addWorkspaceFromFolder,
        addTab: appActions.addTab,
        closeTab: appActions.closeTab,
        splitPane: appActions.splitPane,
        closePane: appActions.closePane,
        openSettings: appActions.openSettings,
      });
    });

    return offCommand;
  }, [activePaneId, activeView, activeWorkspace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      if (event.key === ",") {
        event.preventDefault();
        appActions.openSettings();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!loaded || !config) {
    return <div className={bootScreenClass}>Loading…</div>;
  }

  return (
    <main
      className={`grid h-full min-h-0 w-full bg-swath-bg ${
        sidebarCollapsed ? "grid-cols-[minmax(0,0px)_minmax(0,1fr)]" : "grid-cols-[268px_1fr] max-[980px]:grid-cols-[220px_1fr]"
      }`}
    >
      {sidebarCollapsed ? (
        <div className="pointer-events-none min-w-0 w-0 overflow-hidden" aria-hidden="true" />
      ) : (
        <Sidebar onToggleCollapse={() => useUiStore.getState().setSidebarCollapsed(true)} />
      )}
      <div className="grid min-h-0 min-w-0 grid-rows-[1fr_auto]">
        <section
          className={`flex min-h-0 min-w-0 flex-col border-b border-swath-border ${
            !activeWorkspace && !sidebarCollapsed
              ? "before:block before:h-9 before:shrink-0 before:content-[''] before:[-webkit-app-region:drag] before:[app-region:drag]"
              : ""
          }`}
        >
          {activeWorkspace ? (
            <Suspense fallback={<div className={bootScreenClass}>Loading terminal…</div>}>
              <TerminalWorkspace
                workspace={activeWorkspace}
                settings={config.settings}
                sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={() => toggleSidebarCollapsed()}
              />
            </Suspense>
          ) : (
            <EmptyState sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => toggleSidebarCollapsed()} />
          )}
        </section>
        <StatusBar />
      </div>
      <SettingsModal />
    </main>
  );
}
