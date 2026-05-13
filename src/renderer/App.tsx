import { useEffect, useState } from "react";
import { EmptyState } from "./components/EmptyState";
import { SettingsModal } from "./components/SettingsModal";
import { Sidebar } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TerminalWorkspace } from "./components/TerminalWorkspace";
import { useAppStore } from "./state/appStore";

export function App(): JSX.Element {
  const config = useAppStore((state) => state.config);
  const loaded = useAppStore((state) => state.loaded);
  const hydrate = useAppStore((state) => state.hydrate);
  const addWorkspaceFromFolder = useAppStore((state) => state.addWorkspaceFromFolder);
  const addTab = useAppStore((state) => state.addTab);
  const closeTab = useAppStore((state) => state.closeTab);
  const splitPane = useAppStore((state) => state.splitPane);
  const closePane = useAppStore((state) => state.closePane);
  const openSettings = useAppStore((state) => state.openSettings);
  const activePaneId = useAppStore((state) => state.activePaneId);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const activeWorkspace = config?.workspaces.find((workspace) => workspace.id === config.activeWorkspaceId) ?? null;
  const activeTab = activeWorkspace?.tabs.find((tab) => tab.id === activeWorkspace.activeTabId) ?? activeWorkspace?.tabs[0] ?? null;

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    document.documentElement.classList.add(`platform-${window.tpm.platform}`);
  }, []);

  useEffect(() => {
    const offCommand = window.tpm.app.onCommand((command) => {
      if (command === "workspace:add") void addWorkspaceFromFolder();
      if (command === "tab:new") addTab();
      if (command === "tab:close" && activeWorkspace && activeTab) closeTab(activeWorkspace.id, activeTab.id);
      if (command === "pane:split-right" && activeWorkspace && activeTab && activePaneId) {
        splitPane(activeWorkspace.id, activeTab.id, activePaneId, "vertical");
      }
      if (command === "pane:split-down" && activeWorkspace && activeTab && activePaneId) {
        splitPane(activeWorkspace.id, activeTab.id, activePaneId, "horizontal");
      }
      if (command === "pane:close" && activeWorkspace && activeTab && activePaneId) {
        closePane(activeWorkspace.id, activeTab.id, activePaneId);
      }
    });

    return offCommand;
  }, [activePaneId, activeTab, activeWorkspace, addTab, addWorkspaceFromFolder, closePane, closeTab, splitPane]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      if (event.key === ",") {
        event.preventDefault();
        openSettings();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSettings]);

  if (!loaded || !config) {
    return <div className="boot-screen">Loading…</div>;
  }

  const toggleSidebar = (): void => {
    setSidebarCollapsed((value) => !value);
  };

  return (
    <main className={`app-shell ${sidebarCollapsed ? "app-shell-collapsed" : ""}`}>
      {sidebarCollapsed ? (
        <div className="sidebar-hidden-sentinel" aria-hidden="true" />
      ) : (
        <Sidebar onToggleCollapse={() => setSidebarCollapsed(true)} />
      )}
      <div className="workspace-column">
        <section
          className={`workspace-shell ${activeWorkspace ? "" : "workspace-shell-empty"} ${
            !activeWorkspace && sidebarCollapsed ? "workspace-shell-empty-sidebar-collapsed" : ""
          }`}
        >
          {activeWorkspace ? (
            <TerminalWorkspace
              workspace={activeWorkspace}
              settings={config.settings}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={toggleSidebar}
            />
          ) : (
            <EmptyState sidebarCollapsed={sidebarCollapsed} onToggleSidebar={toggleSidebar} />
          )}
        </section>
        <StatusBar />
      </div>
      <SettingsModal />
    </main>
  );
}
