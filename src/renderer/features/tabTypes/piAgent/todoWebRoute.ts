/**
 * Rectilinear routes between todo-web nodes.
 *
 * Walks a sparse H/V grid around inflated node boxes so edges stay in the gutters, do not clip
 * other cards, and take the shortest orthogonal path with a small extra cost for extra bends.
 */

export interface Point {
  x: number;
  y: number;
}

export interface NodeBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export const ROUTE_CLEARANCE = 10;
const ROUTE_SEPARATION = 5;
const BEND_COST = 10;
const OVERLAP_COST = 1000;

function snap(value: number): number {
  return Math.round(value * 2) / 2;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map(snap))].sort((a, b) => a - b);
}

function collides(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  boxes: NodeBox[],
  pad: number,
): boolean {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  const horizontal = Math.abs(y1 - y2) < 0.01;
  for (const box of boxes) {
    const left = box.x - pad;
    const right = box.x + box.w + pad;
    const top = box.y - pad;
    const bottom = box.y + box.h + pad;
    if (horizontal) {
      if (y1 <= top || y1 >= bottom) continue;
      if (maxX > left && minX < right) return true;
    } else {
      if (x1 <= left || x1 >= right) continue;
      if (maxY > top && minY < bottom) return true;
    }
  }
  return false;
}

function key(x: number, y: number, dir: number): string {
  return `${snap(x)}|${snap(y)}|${dir}`;
}

/** Length shared by two collinear orthogonal segments; crossings have no shared length. */
function sharedLength(a: Point, b: Point, c: Point, d: Point): number {
  const horizontal = a.y === b.y && c.y === d.y && a.y === c.y;
  const vertical = a.x === b.x && c.x === d.x && a.x === c.x;
  if (!horizontal && !vertical) return 0;
  const [a1, a2, c1, c2] = horizontal ? [a.x, b.x, c.x, d.x] : [a.y, b.y, c.y, d.y];
  return Math.max(
    0,
    Math.min(Math.max(a1, a2), Math.max(c1, c2)) - Math.max(Math.min(a1, a2), Math.min(c1, c2)),
  );
}

/** Total distance a candidate segment would overlap routes already drawn. */
function occupiedLength(a: Point, b: Point, occupied: Point[][]): number {
  let length = 0;
  for (const route of occupied) {
    for (let i = 0; i < route.length - 1; i++) length += sharedLength(a, b, route[i], route[i + 1]);
  }
  return length;
}

/**
 * Shortest orthogonal path from `start` to `end` that does not enter `obstacles`.
 *
 * `start` and `end` are typically the right/left ports of two nodes; those two nodes must already
 * be omitted from `obstacles`. `bounds` keeps the search inside the drawing surface.
 */
export function routeOrthogonal(
  start: Point,
  end: Point,
  obstacles: NodeBox[],
  bounds: { w: number; h: number },
  occupied: Point[][] = [],
): Point[] {
  const pad = ROUTE_CLEARANCE;
  const minX = 1;
  const minY = 1;
  const maxX = Math.max(start.x, end.x, bounds.w - 1);
  const maxY = Math.max(start.y, end.y, bounds.h - 1);
  const occupiedPoints = occupied.flat();
  const xs = uniqueSorted([
    start.x,
    end.x,
    minX,
    maxX,
    ...obstacles.flatMap((box) => [box.x - pad, box.x + box.w + pad]),
    ...occupiedPoints.flatMap((point) => [point.x - ROUTE_SEPARATION, point.x + ROUTE_SEPARATION]),
  ]).filter((x) => x >= minX - 0.5 && x <= maxX + 0.5);
  const ys = uniqueSorted([
    start.y,
    end.y,
    minY,
    maxY,
    ...obstacles.flatMap((box) => [box.y - pad, box.y + box.h + pad]),
    ...occupiedPoints.flatMap((point) => [point.y - ROUTE_SEPARATION, point.y + ROUTE_SEPARATION]),
  ]).filter((y) => y >= minY - 0.5 && y <= maxY + 0.5);

  const sx = snap(start.x);
  const sy = snap(start.y);
  const ex = snap(end.x);
  const ey = snap(end.y);
  if (!xs.includes(sx)) xs.push(sx);
  if (!ys.includes(sy)) ys.push(sy);
  if (!xs.includes(ex)) xs.push(ex);
  if (!ys.includes(ey)) ys.push(ey);
  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);

  type State = { x: number; y: number; dir: number; cost: number; prev: State | null };
  const startState: State = { x: sx, y: sy, dir: -1, cost: 0, prev: null };
  const open: State[] = [startState];
  const best = new Map<string, number>([[key(sx, sy, -1), 0]]);
  const closed = new Set<string>();
  let found: State | undefined;

  while (open.length) {
    let bestAt = 0;
    for (let i = 1; i < open.length; i++) if (open[i].cost < open[bestAt].cost) bestAt = i;
    const cur = open.splice(bestAt, 1)[0];
    const id = key(cur.x, cur.y, cur.dir);
    if (closed.has(id)) continue;
    closed.add(id);
    if (cur.x === ex && cur.y === ey) {
      found = cur;
      break;
    }
    const xi = xs.indexOf(cur.x);
    const yi = ys.indexOf(cur.y);
    const options: Array<[number, number, number]> = [];
    if (xi >= 0) {
      if (xi > 0) options.push([xs[xi - 1], cur.y, 0]);
      if (xi < xs.length - 1) options.push([xs[xi + 1], cur.y, 0]);
    }
    if (yi >= 0) {
      if (yi > 0) options.push([cur.x, ys[yi - 1], 1]);
      if (yi < ys.length - 1) options.push([cur.x, ys[yi + 1], 1]);
    }
    for (const [nx, ny, dir] of options) {
      if (collides(cur.x, cur.y, nx, ny, obstacles, pad)) continue;
      const step = Math.abs(nx - cur.x) + Math.abs(ny - cur.y);
      const bend = cur.dir !== -1 && cur.dir !== dir ? BEND_COST : 0;
      const overlap = occupiedLength(cur, { x: nx, y: ny }, occupied) * OVERLAP_COST;
      const cost = cur.cost + step + bend + overlap;
      const nextId = key(nx, ny, dir);
      const prevBest = best.get(nextId);
      if (prevBest !== undefined && prevBest <= cost) continue;
      best.set(nextId, cost);
      open.push({ x: nx, y: ny, dir, cost, prev: cur });
    }
  }

  if (!found) return fallbackAround(start, end, obstacles, bounds);

  const raw: Point[] = [];
  for (let at: State | null = found; at; at = at.prev) raw.push({ x: at.x, y: at.y });
  raw.reverse();
  if (raw[0].x !== start.x || raw[0].y !== start.y) raw.unshift(start);
  const last = raw[raw.length - 1];
  if (last.x !== end.x || last.y !== end.y) raw.push(end);
  return collapseColinear(raw);
}

/** True when any orthogonal segment of `points` enters an inflated obstacle. */
export function pathHits(points: Point[], boxes: NodeBox[], pad = ROUTE_CLEARANCE): boolean {
  for (let i = 0; i < points.length - 1; i++) {
    if (collides(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, boxes, pad))
      return true;
  }
  return false;
}

function fallbackAround(
  start: Point,
  end: Point,
  obstacles: NodeBox[],
  bounds: { w: number; h: number },
): Point[] {
  const top = Math.min(start.y, end.y, ...obstacles.map((box) => box.y)) - ROUTE_CLEARANCE;
  const bot = Math.max(start.y, end.y, ...obstacles.map((box) => box.y + box.h)) + ROUTE_CLEARANCE;
  const yTop = Math.max(2, top);
  const yBot = Math.min(bounds.h - 2, bot);
  const run = (y: number): Point[] => [start, { x: start.x, y }, { x: end.x, y }, end];
  const topPath = run(yTop);
  const botPath = run(yBot);
  const len = (pts: Point[]) =>
    pts
      .slice(1)
      .reduce((sum, pt, i) => sum + Math.abs(pt.x - pts[i].x) + Math.abs(pt.y - pts[i].y), 0);
  return len(topPath) <= len(botPath) ? topPath : botPath;
}

function collapseColinear(points: Point[]): Point[] {
  if (points.length < 3) return points;
  const out = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = out[out.length - 1];
    const b = points[i];
    const c = points[i + 1];
    const colinear =
      (Math.abs(a.x - b.x) < 0.01 && Math.abs(b.x - c.x) < 0.01) ||
      (Math.abs(a.y - b.y) < 0.01 && Math.abs(b.y - c.y) < 0.01);
    if (!colinear) out.push(b);
  }
  out.push(points[points.length - 1]);
  return out;
}

/** SVG path with rounded elbows from an orthogonal polyline. */
export function roundedPath(points: Point[], radius = 8): string {
  if (points.length < 2) return "";
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const prev = points[i - 1];
    const corner = points[i];
    const next = points[i + 1];
    const inDx = corner.x - prev.x;
    const inDy = corner.y - prev.y;
    const outDx = next.x - corner.x;
    const outDy = next.y - corner.y;
    const inLen = Math.hypot(inDx, inDy) || 1;
    const outLen = Math.hypot(outDx, outDy) || 1;
    const rad = Math.min(radius, inLen / 2, outLen / 2);
    d += ` L ${corner.x - (inDx / inLen) * rad} ${corner.y - (inDy / inLen) * rad}`;
    d += ` Q ${corner.x} ${corner.y} ${corner.x + (outDx / outLen) * rad} ${corner.y + (outDy / outLen) * rad}`;
  }
  const last = points[points.length - 1];
  d += ` L ${last.x} ${last.y}`;
  return d;
}
