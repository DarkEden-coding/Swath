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
    return <div className="boot-screen">Loading…</div>;
  }

  return (
    <main className={`app-shell ${sidebarCollapsed ? "app-shell-collapsed" : ""}`}>
      {sidebarCollapsed ? (
        <div className="sidebar-hidden-sentinel" aria-hidden="true" />
      ) : (
        <Sidebar onToggleCollapse={() => useUiStore.getState().setSidebarCollapsed(true)} />
      )}
      <div className="workspace-column">
        <section
          className={`workspace-shell ${activeWorkspace ? "" : "workspace-shell-empty"} ${
            !activeWorkspace && sidebarCollapsed ? "workspace-shell-empty-sidebar-collapsed" : ""
          }`}
        >
          {activeWorkspace ? (
            <Suspense fallback={<div className="boot-screen">Loading terminal…</div>}>
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
