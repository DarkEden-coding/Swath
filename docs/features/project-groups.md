# Project groups

Several folders that make up one logical project can be tied together into a group. A group adds a
shared agents surface spanning every folder, while each project keeps its own terminals and its own
per-folder pi agents.

## Model

A group is not a parallel entity to a workspace — **its root _is_ a workspace**:

| Field            | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| `isGroupRoot`    | This workspace is a group's shared surface, not a folder |
| `groupId`        | On a member project: the id of its group root            |
| `groupCollapsed` | Group root only: members are hidden in the sidebar       |

Because the root is a workspace, every view, pane and tab operation keyed by workspace id works on
the shared surface with no special case. The root borrows the first member's folder as its `path`,
so its agents always start somewhere real.

`config.workspaces` stays flat and authoritative for sidebar order, under one invariant: **a root is
immediately followed by its members**. `reflowGroups` in
`src/renderer/domain/workspaces/groupActions.ts` restores that after every mutation, and also drops
orphaned membership and dissolves any group left with fewer than two projects.

## Interaction

- Right-click a project → **Group with ▸** to join an existing group or pair with another project.
- Right-click a project in a group → **Remove from group**.
- Right-click the group header → rename, hide/show its projects, or break the group up.
- Dragging the header moves the whole group. Dragging a project into a group's block joins that
  group; dragging it out leaves.
- Removing a group removes the group only — its projects stay in Swath. Dropping below two projects
  breaks the group up, which closes its shared agents (confirmed first when they are running).

## What the agent gets

pi has no multi-root option, and its tools are not confined to the working directory. A pane on a
group root therefore spawns in the primary folder and appends the full folder list to the system
prompt (`groupPathArgs` in `usePiAgent.ts`, passed through the existing `args` pass-through to
`pi_agent.rs`). No pi extension is involved. The folder list is read at spawn time only, so adding a
project to a group never restarts a running conversation — restart the pane to pick it up.

### Indexing across the group

Everything the pane resolves by path follows the same rule — the working directory plus the group's
other folders, exposed through `PiRootsContext` so deep transcript components need no new props:

- **`@` completion** (`files` op) walks every folder, splitting the candidate budget evenly so one
  large repository cannot crowd out its siblings. The working directory yields relative paths as
  before; sibling folders yield absolute ones, because pi resolves a mention against its working
  directory and only an absolute path reaches outside it.

  The composer never shows those absolute paths. A candidate is labelled from its own project's
  root — `FIRST-Note-Detection/ROADMAP.md`, not the full path it lives at — and `expandMentions`
  rewrites the label into the resolvable path when the message is sent (`mentions.ts`). A label two
  folders would both claim keeps its absolute form, which is unambiguous by construction. Because a
  mention is inserted as one object it also deletes as one: Backspace at its end, or Delete at its
  start, takes the whole path and its padding space in a single keypress. The labels the composer
  inserted are remembered per pane, so a tab switch does not turn them back into plain text.

- **Live file diffs** read the edited file from whichever folder owns it, and label it with that
  folder's name so two `src/index.ts` never look like one file.
- **Question images** (`ask_images`) accept a path under any folder of the group, not just `cwd`.
  Containment is still enforced: a path under none of them is refused, as is a symlinked leaf.

A group's tab bar offers only the kinds that make sense across several folders (`GROUP_VIEW_KINDS`);
terminals stay deliberately per-project.
