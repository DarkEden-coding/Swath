import { useTaskStore } from "../../state/taskStore";

export function TaskProjectSidebar(): JSX.Element {
  const { catalog, local, selectProject } = useTaskStore();
  return (
    <>
      <header className="flex items-center px-3.5 pb-2 pt-2.5">
        <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-swath-muted-2">
          Projects
        </div>
      </header>
      <div className="flex-1 overflow-y-auto px-2" role="list">
        {catalog.projects.map((project) => (
          <button
            key={project.id}
            role="listitem"
            onClick={() => selectProject(project.id)}
            className={`my-0.5 flex w-full rounded-md px-3 py-2 text-left text-[13px] ${project.id === local.activeProjectId ? "bg-[rgba(56,139,253,0.12)] text-swath-text" : "text-swath-muted hover:bg-swath-bg"}`}
          >
            {project.name}
          </button>
        ))}
      </div>
    </>
  );
}
