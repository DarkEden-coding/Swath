import type { JSX } from "react";
import type { GitLogEntry } from "../../../services/gitClient";

/** Row height (px) — keep in sync with commit list rows in GitManagerPane. */
export const COMMIT_GRAPH_ROW_H = 56;

/** Visual lane width for one commit graph column (px). */
export const COMMIT_GRAPH_CELL_W = 36;

const LANE_STROKES = ["#58a6ff", "#d29922", "#3fb950", "#a371f7", "#8b949e"];

function laneStroke(col: number): string {
  return LANE_STROKES[col % LANE_STROKES.length];
}

interface GraphPath {
  key: string;
  fromCol: number;
  toCol: number;
  fromRow: number;
  toRow: number;
}

interface GraphNode {
  key: string;
  col: number;
  row: number;
  merge: boolean;
}

export interface CommitGraphLayout {
  cols: number;
  rows: number;
  paths: GraphPath[];
  nodes: GraphNode[];
}

function uniqueParents(parents: readonly string[]): string[] {
  return [...new Set(parents)];
}

export function buildCommitGraphLayout(commits: readonly GitLogEntry[]): CommitGraphLayout {
  const lanes: string[] = [];
  const paths: GraphPath[] = [];
  const nodes: GraphNode[] = [];
  let cols = 1;

  commits.forEach((commit, row) => {
    let col = lanes.indexOf(commit.hash);
    if (col === -1) {
      col = lanes.length;
      lanes.push(commit.hash);
    }

    const parents = uniqueParents(commit.parents);
    nodes.push({ key: `cg-node-${commit.hash}`, col, row, merge: parents.length > 1 });

    const nextLanes = [...lanes];
    if (parents.length === 0) {
      nextLanes.splice(col, 1);
    } else {
      nextLanes.splice(col, 1);
      let insertAt = col;
      parents.forEach((parent) => {
        let parentCol = nextLanes.indexOf(parent);
        if (parentCol === -1) {
          parentCol = insertAt;
          nextLanes.splice(insertAt, 0, parent);
          insertAt += 1;
        }
        paths.push({
          key: `cg-path-${row}-${commit.hash}-${parent}`,
          fromCol: col,
          toCol: parentCol,
          fromRow: row,
          toRow: row + 1,
        });
      });
    }

    lanes.forEach((hash, laneCol) => {
      if (hash === commit.hash) return;
      const nextCol = nextLanes.indexOf(hash);
      if (nextCol === -1) return;
      paths.push({
        key: `cg-path-${row}-${hash}-${laneCol}`,
        fromCol: laneCol,
        toCol: nextCol,
        fromRow: row,
        toRow: row + 1,
      });
    });

    lanes.splice(0, lanes.length, ...nextLanes);
    cols = Math.max(cols, lanes.length, col + parents.length);
  });

  return { cols, rows: commits.length, paths, nodes };
}

/**
 * Renders Git's `--graph` ASCII as vector lines and commit nodes so merges and
 * branch lanes read as a connected tree (not only colored text).
 */
export function CommitGraphSvg({
  layout,
  rowHeight,
  cellWidth,
}: {
  layout: CommitGraphLayout;
  rowHeight: number;
  cellWidth: number;
}): JSX.Element {
  const w = layout.cols * cellWidth;
  const h = layout.rows * rowHeight;
  const strokeW = 3;
  const back = "#161b22";

  const xForCol = (col: number): number => col * cellWidth + cellWidth / 2;
  const yForRow = (row: number): number => row * rowHeight + rowHeight / 2;

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="block select-none text-swath-muted-2"
      role="img"
      aria-label="Commit graph"
    >
      <title>Commit ancestry graph</title>
      <g className="commit-graph-rails">
        {layout.paths.map((path) => {
          const x1 = xForCol(path.fromCol);
          const y1 = yForRow(path.fromRow);
          const x2 = xForCol(path.toCol);
          const y2 = yForRow(path.toRow);
          const midY = y1 + (y2 - y1) / 2;
          const d = x1 === x2 ? `M ${x1} ${y1} L ${x2} ${y2}` : `M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`;
          return (
            <path
              key={path.key}
              d={d}
              fill="none"
              stroke={laneStroke(path.fromCol)}
              strokeWidth={strokeW}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          );
        })}
      </g>
      <g className="commit-graph-nodes">
        {layout.nodes.map((node) => (
          <circle
            key={node.key}
            cx={xForCol(node.col)}
            cy={yForRow(node.row)}
            r={node.merge ? 5.7 : 4.7}
            fill={back}
            stroke={laneStroke(node.col)}
            strokeWidth={node.merge ? 3 : 2.5}
          />
        ))}
      </g>
    </svg>
  );
}
