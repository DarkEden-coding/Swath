import path from "node:path";
import type { LayoutNode, TerminalTab, Workspace } from "./sharedTypes";

/**
 * When true and the user has no saved workspaces, starter demo projects and
 * layouts are applied on load. Set to false to ship an empty sidebar by default.
 */
export const ENABLE_STARTER_UI_DEMO = true;

const GIT_BANNER =
  "\r\n\x1b[1;32mapi@acme-platform\x1b[0m:\x1b[1;34m~/projects/api\x1b[0m$ \x1b[1mgit status\x1b[0m\r\n" +
  "On branch main\r\n" +
  "Your branch is up to date with 'origin/main'.\r\n\r\n" +
  "Changes not staged for commit:\r\n" +
  "  (use \"git add <file>...\" to update what will be committed)\r\n" +
  "\x1b[31m        modified:   src/routes/auth.ts\x1b[0m\r\n" +
  "\x1b[31m        modified:   package.json\x1b[0m\r\n\r\n" +
  "no changes added to commit\r\n";

const NPM_BANNER =
  "\r\n\x1b[1;32mapi@acme-platform\x1b[0m:\x1b[1;34m~/projects/api\x1b[0m$ \x1b[1mnpm run dev\x1b[0m\r\n\r\n" +
  "\x1b[33m> api@1.0.0 dev\x1b[0m\r\n" +
  "\x1b[33m> nodemon src/index.ts\x1b[0m\r\n\r\n" +
  "\x1b[32m[nodemon] starting `ts-node src/index.ts`\x1b[0m\r\n" +
  "\x1b[32mServer listening on :4000\x1b[0m\r\n" +
  "\x1b[36mGET\x1b[0m /health 200 12ms\r\n" +
  "\x1b[36mGET\x1b[0m /v1/users 200 44ms\r\n";

const DOCKER_BANNER =
  "\r\n\x1b[1;32mapi@acme-platform\x1b[0m:\x1b[1;34m~/projects/api\x1b[0m$ \x1b[1mdocker ps\x1b[0m\r\n" +
  "CONTAINER ID   IMAGE           COMMAND                  STATUS         PORTS\r\n" +
  "a1b2c3d4e5f6   postgres:16     \"docker-entrypoint.s…\"   Up 2 hours     0.0.0.0:5432->5432/tcp\r\n" +
  "9f8e7d6c5b4a   redis:7         \"docker-entrypoint.s…\"   Up 2 hours     0.0.0.0:6379->6379/tcp\r\n" +
  "123456789abc   api:dev         \"node dist/index.js\"     Up 8 minutes   0.0.0.0:4000->4000/tcp\r\n";

function acmeLayout(): LayoutNode {
  const paneGit: LayoutNode = {
    type: "pane",
    id: "demo-pane-git",
    promptLabel: "api@acme-platform: ~/projects/api",
    demoBanner: GIT_BANNER,
  };
  const paneNpm: LayoutNode = {
    type: "pane",
    id: "demo-pane-npm",
    promptLabel: "api@acme-platform: ~/projects/api",
    demoBanner: NPM_BANNER,
  };
  const paneDocker: LayoutNode = {
    type: "pane",
    id: "demo-pane-docker",
    promptLabel: "api@acme-platform: ~/projects/api",
    demoBanner: DOCKER_BANNER,
  };

  const topRow: LayoutNode = {
    type: "split",
    id: "demo-split-top",
    direction: "vertical",
    ratio: 0.52,
    first: paneGit,
    second: paneNpm,
  };

  return {
    type: "split",
    id: "demo-split-root",
    direction: "horizontal",
    ratio: 0.58,
    first: topRow,
    second: paneDocker,
  };
}

function acmeTabs(): TerminalTab[] {
  const layout = acmeLayout();
  const tabMain: TerminalTab = {
    id: "demo-tab-backend",
    title: "Backend API Dev",
    health: "healthy",
    layout,
    activePaneId: "demo-pane-git",
  };
  const tabDb: TerminalTab = {
    id: "demo-tab-db",
    title: "Database Console",
    health: "warning",
    layout: { type: "pane", id: "demo-pane-db", promptLabel: "postgres@acme-platform: ~", demoBanner: "\r\n\x1b[2m-- demo: psql connected to staging\x1b[0m\r\n" },
    activePaneId: "demo-pane-db",
  };
  const tabWorker: TerminalTab = {
    id: "demo-tab-worker",
    title: "Worker Logs",
    health: "healthy",
    layout: { type: "pane", id: "demo-pane-worker", promptLabel: "worker@acme-platform: ~/jobs", demoBanner: "\r\n\x1b[33m[INFO]\x1b[0m queue=default job=compile_assets ok=1\r\n" },
    activePaneId: "demo-pane-worker",
  };
  const tabCi: TerminalTab = {
    id: "demo-tab-ci",
    title: "CI/CD Pipeline",
    health: "idle",
    layout: { type: "pane", id: "demo-pane-ci", promptLabel: "ci@acme-platform: ~/pipeline", demoBanner: "\r\n\x1b[2m-- demo: last run succeeded (main)\x1b[0m\r\n" },
    activePaneId: "demo-pane-ci",
  };
  return [tabMain, tabDb, tabWorker, tabCi];
}

function demoWorkspace(name: string, id: string, home: string): Workspace {
  const ts = Date.now();
  const single: TerminalTab = {
    id: `${id}-tab`,
    title: "Terminal",
    health: "idle",
    layout: { type: "pane", id: `${id}-pane`, promptLabel: `${name.toLowerCase().replace(/\s+/g, "")}@local: ~` },
    activePaneId: `${id}-pane`,
  };
  return {
    id,
    name,
    path: path.join(home, "Documents"),
    tabs: [single],
    activeTabId: single.id,
    createdAt: ts,
    updatedAt: ts,
  };
}

export function createStarterDemoWorkspaces(home: string): Workspace[] {
  const ts = Date.now();
  const acme: Workspace = {
    id: "demo-ws-acme",
    name: "Acme Platform",
    path: home,
    tabs: acmeTabs(),
    activeTabId: "demo-tab-backend",
    createdAt: ts,
    updatedAt: ts,
  };

  return [
    acme,
    demoWorkspace("API Gateway", "demo-ws-gateway", home),
    demoWorkspace("Web Dashboard", "demo-ws-dash", home),
    demoWorkspace("Data Pipeline", "demo-ws-pipeline", home),
    demoWorkspace("Auth Service", "demo-ws-auth", home),
    demoWorkspace("Mobile App", "demo-ws-mobile", home),
    demoWorkspace("Infrastructure", "demo-ws-infra", home),
    demoWorkspace("DevOps Scripts", "demo-ws-devops", home),
  ];
}

export function applyStarterDemoIfEmpty(home: string, workspaces: Workspace[]): Workspace[] {
  if (!ENABLE_STARTER_UI_DEMO || workspaces.length > 0) return workspaces;
  return createStarterDemoWorkspaces(home);
}
