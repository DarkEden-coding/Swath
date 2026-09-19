import { useTaskStore } from "../../state/taskStore";
import { countPiAgents, usePiActivityStore } from "../tabTypes/piAgent/piActivity";

export function TaskProjectSidebar(): JSX.Element {
  const { catalog, local, selectProject } = useTaskStore();
  const activity = usePiActivityStore((state) => state.activity);
  return (
    <>
      <header className="flex items-center px-3.5 pb-2 pt-2.5">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-swath-muted-2">
          Projects
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-2" role="list">
        {catalog.projects.map((project) => {
          const taskIds = new Set(
            catalog.tasks.filter((task) => task.projectId === project.id).map((task) => task.id),
          );
          const piIds = catalog.panes
            .filter((pane) => taskIds.has(pane.taskId) && pane.kind === "piAgent")
            .map((pane) => pane.id);
          const counts = countPiAgents(activity, piIds);
          return (
            <button
              key={project.id}
              role="listitem"
              onClick={() => selectProject(project.id)}
              className={`my-0.5 flex w-full rounded-md px-3 py-2 text-left text-[13px] ${project.id === local.activeProjectId ? "bg-[rgba(56,139,253,0.12)] text-swath-text" : "text-swath-muted hover:bg-swath-bg"}`}
            >
              <span className="min-w-0 flex-1 truncate">{project.name}</span>
              {counts.running ? (
                <span
                  className="ml-2 size-2 animate-pulse rounded-full bg-swath-good"
                  title={`${counts.running} agent running`}
                />
              ) : counts.done ? (
                <span
                  className="ml-2 text-xs text-swath-good"
                  title={`${counts.done} agent finished`}
                >
                  ✓
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </>
  );
}
