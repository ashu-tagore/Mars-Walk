// Engine core: directional energy cost, A*, Dijkstra, routes, walk-back envelope, shelter times.
// No DOM, no app state. Every constant comes from constants.ts (docs/assumptions.md).

import {
  ASTRONAUT_MASS_KG,
  AVG_METABOLIC_KJ_PER_H,
  BUDDY_MAX_SEPARATION_M,
  CAUTION_SLOPE_DEG,
  EVA_DURATION_H,
  MARS_GRAVITY,
  MAX_SLOPE_DEG,
  MAX_WALK_RADIUS_M,
  NO_CORNER_CUTTING,
  RESCUE_DISTANCE_M,
  RESCUE_SPEED_M_PER_S,
  RESERVE_FRACTION,
  SANTEE_DOWNHILL_COEF,
  SANTEE_DOWNHILL_DECAY_BASE,
  SANTEE_DOWNHILL_DECAY_DEG,
  SANTEE_LEVEL_BASE,
  SANTEE_LEVEL_MASS_COEF,
  SANTEE_LEVEL_OFFSET_W,
  SANTEE_LEVEL_SPEED_COEF,
  SANTEE_MIN_LEVEL_FRACTION,
  SANTEE_UPHILL_COEF,
  SECONDS_PER_HOUR,
  SECONDS_PER_MINUTE,
  TURN_ANGLE_DEG,
  SEP_SHELTER_TARGET_MIN,
  STATION_WORK_W,
  STOP_DWELL_MIN,
  SUIT_AND_GEAR_MASS_KG,
  WALK_SPEED_M_PER_S,
} from "./constants";
import { Cell, Grid, cellAt, cellIndex, isInside } from "./grid";

// ---- Contract reply types (docs/data-contract.md, section 4) ----

export type RouteLeg = { from: string; to: string; distanceM: number; energyJ: number; timeS: number };

// cellIndex = index in Route.path where the step starts (docs/data-contract.md, section 4.2).
export type Instruction = { text: string; direction: string; distanceM: number; warning?: string; cellIndex: number };

export type Route = {
  type: "route";
  path: Cell[];
  legs: RouteLeg[]; // walking only
  stopTimeS: number; // STOP_DWELL_MIN at each stop
  stopEnergyJ: number; // stopTimeS at STATION_WORK_W
  totalEnergyJ: number; // legs + stopEnergyJ
  totalTimeS: number; // legs + stopTimeS
  elevationProfile: { distanceM: number; elevationM: number }[];
  verdict: "GO" | "CAUTION" | "NO_GO";
  reasons: string[];
  instructions: Instruction[];
};

export type Envelope = {
  type: "envelope";
  mask: Uint8Array; // 0 = cannot return, 1 = return within reserve only, 2 = safe
  remainingJ: number;
  turnBackAtS: number;
};

export type ShelterTimes = {
  type: "shelterTimes";
  options: { shelterId: string; kind: "full" | "partial"; timeS: number; path: Cell[] }[];
};

// ---- Parameters ----

// Keys are the docs/assumptions.md names, so setParams can take them as they are.
export type Params = {
  ASTRONAUT_MASS_KG: number;
  SUIT_AND_GEAR_MASS_KG: number;
  WALK_SPEED_M_PER_S: number;
  RESCUE_SPEED_M_PER_S: number;
  BUDDY_MAX_SEPARATION_M: number;
  MAX_SLOPE_DEG: number;
  CAUTION_SLOPE_DEG: number;
  MAX_WALK_RADIUS_M: number;
  RESERVE_FRACTION: number;
  EVA_DURATION_H: number;
  AVG_METABOLIC_KJ_PER_H: number;
  STATION_WORK_W: number;
  STOP_DWELL_MIN: number;
  SEP_SHELTER_TARGET_MIN: number;
  // null = derived from EVA_DURATION_H and AVG_METABOLIC_KJ_PER_H (docs/assumptions.md, EVA_ENERGY_BUDGET_J).
  EVA_ENERGY_BUDGET_J: number | null;
};

export function defaultParams(): Params {
  return {
    ASTRONAUT_MASS_KG,
    SUIT_AND_GEAR_MASS_KG,
    WALK_SPEED_M_PER_S,
    RESCUE_SPEED_M_PER_S,
    BUDDY_MAX_SEPARATION_M,
    MAX_SLOPE_DEG,
    CAUTION_SLOPE_DEG,
    MAX_WALK_RADIUS_M,
    RESERVE_FRACTION,
    EVA_DURATION_H,
    AVG_METABOLIC_KJ_PER_H,
    STATION_WORK_W,
    STOP_DWELL_MIN,
    SEP_SHELTER_TARGET_MIN,
    EVA_ENERGY_BUDGET_J: null,
  };
}

// Returns a new Params. Throws on an unknown name or a bad value, so the worker can answer with an error.
export function applyParams(params: Params, changes: Record<string, unknown>): Params {
  const next: Params = { ...params };
  for (const name of Object.keys(changes)) {
    if (!(name in next)) throw new Error(`unknown parameter ${name}`);
    const value = changes[name];
    const resetBudget = name === "EVA_ENERGY_BUDGET_J" && value === null;
    if (resetBudget) {
      next.EVA_ENERGY_BUDGET_J = null;
      continue;
    }
    const isValidNumber = typeof value === "number" && Number.isFinite(value) && value >= 0;
    if (!isValidNumber) throw new Error(`parameter ${name} must be a number >= 0`);
    if (name === "RESERVE_FRACTION" && value >= 1) throw new Error("RESERVE_FRACTION must be below 1");
    (next as Record<string, number | null>)[name] = value;
  }
  return next;
}

// Also fixed in terrain_cost.bin (impassable cells, caution penalty). A setParams change would make the edge rule
// disagree with the cell costs, so setParams rejects them (docs/data-contract.md, version 9). Tests may still set them
// with applyParams on a fixture whose cell costs match.
export const SITE_FILE_PARAMS = ["MAX_SLOPE_DEG", "CAUTION_SLOPE_DEG"];

export function checkRuntimeParams(changes: Record<string, unknown>): void {
  const fixed = Object.keys(changes).filter((name) => SITE_FILE_PARAMS.includes(name));
  if (fixed.length === 0) return;
  throw new Error(`${fixed.join(", ")}: fixed in terrain_cost.bin. Change docs/assumptions.md and run the pipeline again`);
}

export function energyBudgetJ(params: Params): number {
  if (params.EVA_ENERGY_BUDGET_J !== null) return params.EVA_ENERGY_BUDGET_J;
  return params.EVA_DURATION_H * params.AVG_METABOLIC_KJ_PER_H * 1000;
}

// Mass and speed are parameters, so walking and rescue use the same cost model.
// maxPathM: the longest path this move may cover to reach a return point (Infinity = no limit).
export type MoveParams = { massKg: number; speedMPerS: number; maxSlopeDeg: number; maxPathM: number };

export function walkingMove(params: Params): MoveParams {
  return {
    massKg: params.ASTRONAUT_MASS_KG + params.SUIT_AND_GEAR_MASS_KG,
    speedMPerS: params.WALK_SPEED_M_PER_S,
    maxSlopeDeg: params.MAX_SLOPE_DEG,
    maxPathM: Infinity,
  };
}

// Buddy rescue (CLAUDE.md): the rescuer carries the incapacitated crewmember as LOAD in the Santee model.
// M = rescuer + injured, both with suit and gear. No other multiplier.
// The carry path is limited to RESCUE_DISTANCE_M (NASA lunar rescue design, docs/assumptions.md).
export function rescueMove(params: Params): MoveParams {
  return {
    massKg: 2 * (params.ASTRONAUT_MASS_KG + params.SUIT_AND_GEAR_MASS_KG),
    speedMPerS: params.RESCUE_SPEED_M_PER_S,
    maxSlopeDeg: params.MAX_SLOPE_DEG,
    maxPathM: RESCUE_DISTANCE_M,
  };
}

// ---- Cost model ----

const DEG = Math.PI / 180;

// 8 neighbours: N, NE, E, SE, S, SW, W, NW. Fixed order keeps the search deterministic.
const DCOL = [0, 1, 1, 1, 0, -1, -1, -1];
const DROW = [-1, -1, 0, 1, 1, 1, 0, -1];

// Santee et al. 2001 metabolic rate in W, theta signed (positive = uphill).
// TODO: coefficients are confirmed only through Johnson et al. 2010 (secondary source).
// See docs/assumptions.md "Metabolic model" and docs/research.md section 2.5. Do not change them without the original paper.
function santeeLevelWatts(massKg: number, speedMPerS: number, thetaRad: number): number {
  return (
    (SANTEE_LEVEL_MASS_COEF * massKg + SANTEE_LEVEL_OFFSET_W) *
    (SANTEE_LEVEL_SPEED_COEF * speedMPerS * Math.cos(thetaRad) + SANTEE_LEVEL_BASE)
  );
}

export function santeeWatts(massKg: number, speedMPerS: number, thetaRad: number): number {
  const levelW = santeeLevelWatts(massKg, speedMPerS, thetaRad);

  let slopeW = 0;
  if (thetaRad > 0) {
    slopeW = SANTEE_UPHILL_COEF * massKg * MARS_GRAVITY * speedMPerS * Math.sin(thetaRad);
  }
  if (thetaRad < 0) {
    const thetaDeg = Math.abs(thetaRad) / DEG;
    const downhillDecay = SANTEE_DOWNHILL_DECAY_BASE ** (thetaDeg / SANTEE_DOWNHILL_DECAY_DEG);
    slopeW = SANTEE_DOWNHILL_COEF * massKg * MARS_GRAVITY * speedMPerS * Math.sin(thetaRad) * downhillDecay;
  }
  return Math.max(levelW + slopeW, levelW * SANTEE_MIN_LEVEL_FRACTION);
}

// Neighbours only. A diagonal neighbour differs in both column and row.
function horizontalM(grid: Grid, from: number, to: number): number {
  const sameCol = from % grid.width === to % grid.width;
  const sameRow = Math.floor(from / grid.width) === Math.floor(to / grid.width);
  const isDiagonal = !sameCol && !sameRow;
  return isDiagonal ? grid.cellSizeM * Math.SQRT2 : grid.cellSizeM;
}

// ---- Edge energy cache ----
// The planner runs one search per candidate and the simulator a full walk-back per request, all over the same grid and
// move. Each edge needs atan, cos, sin and a power, so each edge energy is computed once per grid and move and then
// read back. Values are computed by computeEdgeEnergyJ either way, so every result is bit-identical with or without it.
// One Float64 per edge: 8 * 1000 * 1000 * 8 bytes = 64 MB per move on the real site. Only the two newest moves are
// kept (walking and rescue); a setParams change makes a new move and drops the oldest cache.
const MAX_CACHED_MOVES = 2;
const edgeCaches = new WeakMap<Grid, Map<string, Float64Array>>();

// Neighbour slot k (DCOL / DROW order) from the row and column offset: index (dRow + 1) * 3 + (dCol + 1). -1 = not a neighbour.
const NEIGHBOUR_SLOT = [7, 0, 1, 6, -1, 2, 5, 4, 3];

// A search passes the same grid and move object for millions of edges: remember the last lookup by identity.
let lastLookup: { grid: Grid; move: MoveParams; cache: Float64Array } | null = null;

function edgeCache(grid: Grid, move: MoveParams): Float64Array {
  if (lastLookup && lastLookup.grid === grid && lastLookup.move === move) return lastLookup.cache;
  const cache = findOrCreateCache(grid, move);
  lastLookup = { grid, move, cache };
  return cache;
}

function findOrCreateCache(grid: Grid, move: MoveParams): Float64Array {
  let caches = edgeCaches.get(grid);
  if (!caches) {
    caches = new Map();
    edgeCaches.set(grid, caches);
  }
  const key = `${move.massKg}|${move.speedMPerS}|${move.maxSlopeDeg}`;
  let cache = caches.get(key);
  if (cache) return cache;
  if (caches.size >= MAX_CACHED_MOVES) caches.delete(caches.keys().next().value as string);
  // NaN = not computed yet (an edge energy is never NaN: it is a number or Infinity).
  cache = new Float64Array(grid.width * grid.height * 8).fill(NaN);
  caches.set(key, cache);
  return cache;
}

// Energy (J) to walk from cell `from` to its neighbour `to`. Infinity = impassable. Cached per grid and move.
export function edgeEnergyJ(grid: Grid, from: number, to: number, move: MoveParams): number {
  const width = grid.width;
  const fromCol = from % width;
  const toCol = to % width;
  const dCol = toCol - fromCol;
  const dRow = (to - toCol) / width - (from - fromCol) / width;
  const isNeighbour = Math.abs(dCol) <= 1 && Math.abs(dRow) <= 1 && (dCol !== 0 || dRow !== 0);
  if (!isNeighbour) return computeEdgeEnergyJ(grid, from, to, move);

  const cache = edgeCache(grid, move);
  const slot = from * 8 + NEIGHBOUR_SLOT[(dRow + 1) * 3 + (dCol + 1)];
  const cached = cache[slot];
  if (!Number.isNaN(cached)) return cached;
  const energyJ = computeEdgeEnergyJ(grid, from, to, move);
  cache[slot] = energyJ;
  return energyJ;
}

// The terrain multiplier of the destination cell already holds caution, roughness and boulder factors.
// Both ends must be passable: an impassable cell is never on a route, not even as the first cell (CLAUDE.md, hard rules).
function computeEdgeEnergyJ(grid: Grid, from: number, to: number, move: MoveParams): number {
  const costByte = grid.terrainCost[to];
  const endBlocked = costByte === grid.impassable || grid.terrainCost[from] === grid.impassable;
  if (endBlocked) return Infinity;

  const zFrom = grid.elevation[from];
  const zTo = grid.elevation[to];
  if (zFrom === grid.noData || zTo === grid.noData) return Infinity;

  const width = grid.width;
  const fromCol = from % width;
  const toCol = to % width;
  const fromRow = (from - fromCol) / width;
  const toRow = (to - toCol) / width;
  const isDiagonal = fromCol !== toCol && fromRow !== toRow;
  if (isDiagonal && NO_CORNER_CUTTING) {
    const sideA = fromRow * width + toCol;
    const sideB = toRow * width + fromCol;
    const sideBlocked = grid.terrainCost[sideA] === grid.impassable || grid.terrainCost[sideB] === grid.impassable;
    if (sideBlocked) return Infinity;
  }

  const runM = isDiagonal ? grid.cellSizeM * Math.SQRT2 : grid.cellSizeM;
  const riseM = zTo - zFrom;
  const edgeTooSteep = Math.abs(riseM) > runM * Math.tan(move.maxSlopeDeg * DEG);
  if (edgeTooSteep) return Infinity;

  const theta = Math.atan(riseM / runM);
  const surfaceM = Math.sqrt(runM * runM + riseM * riseM);
  const watts = santeeWatts(move.massKg, move.speedMPerS, theta);
  return watts * (surfaceM / move.speedMPerS) * costByte * grid.terrainScale;
}

// Distance walked on the ground (not the map distance) between two neighbours.
export function edgeSurfaceM(grid: Grid, from: number, to: number): number {
  const runM = horizontalM(grid, from, to);
  const riseM = grid.elevation[to] - grid.elevation[from];
  return Math.sqrt(runM * runM + riseM * riseM);
}

// Same value as edgeSurfaceM for the neighbour in slot k (DCOL / DROW order: odd slots are diagonal), without working
// out from the indices whether the step is diagonal. Used inside the search loops. Symmetric: u -> v equals v -> u.
function slotSurfaceM(grid: Grid, from: number, to: number, k: number): number {
  const runM = k % 2 === 1 ? grid.cellSizeM * Math.SQRT2 : grid.cellSizeM;
  const riseM = grid.elevation[to] - grid.elevation[from];
  return Math.sqrt(runM * runM + riseM * riseM);
}

export function edgeTimeS(grid: Grid, from: number, to: number, move: MoveParams): number {
  return edgeSurfaceM(grid, from, to) / move.speedMPerS;
}

function edgeSlopeDeg(grid: Grid, from: number, to: number): number {
  const riseM = grid.elevation[to] - grid.elevation[from];
  return Math.atan(Math.abs(riseM) / horizontalM(grid, from, to)) / DEG;
}

// ---- Binary min-heap on typed arrays, with decrease-key ----
// Keys live in the caller's array (energy or f-score), so the heap stores only cell indices.

type Heap = { cells: Int32Array; pos: Int32Array; size: number; key: Float64Array };

function createHeap(cellCount: number, key: Float64Array): Heap {
  return { cells: new Int32Array(cellCount), pos: new Int32Array(cellCount).fill(-1), size: 0, key };
}

// Equal keys: the smaller cell index wins, so the result does not depend on insertion order details.
function heapLess(heap: Heap, a: number, b: number): boolean {
  const keyA = heap.key[a];
  const keyB = heap.key[b];
  if (keyA !== keyB) return keyA < keyB;
  return a < b;
}

function heapPlace(heap: Heap, slot: number, cell: number): void {
  heap.cells[slot] = cell;
  heap.pos[cell] = slot;
}

function siftUp(heap: Heap, slot: number): void {
  const cell = heap.cells[slot];
  while (slot > 0) {
    const parentSlot = (slot - 1) >> 1;
    const parent = heap.cells[parentSlot];
    if (!heapLess(heap, cell, parent)) break;
    heapPlace(heap, slot, parent);
    slot = parentSlot;
  }
  heapPlace(heap, slot, cell);
}

function siftDown(heap: Heap, slot: number): void {
  const cell = heap.cells[slot];
  while (true) {
    const left = 2 * slot + 1;
    if (left >= heap.size) break;
    const right = left + 1;
    let child = left;
    if (right < heap.size && heapLess(heap, heap.cells[right], heap.cells[left])) child = right;
    if (!heapLess(heap, heap.cells[child], cell)) break;
    heapPlace(heap, slot, heap.cells[child]);
    slot = child;
  }
  heapPlace(heap, slot, cell);
}

// Call after the cell's key went down (or for a new cell).
function heapPushOrDecrease(heap: Heap, cell: number): void {
  const slot = heap.pos[cell];
  if (slot >= 0) {
    siftUp(heap, slot);
    return;
  }
  heap.size += 1;
  heapPlace(heap, heap.size - 1, cell);
  siftUp(heap, heap.size - 1);
}

function heapPop(heap: Heap): number {
  const top = heap.cells[0];
  heap.pos[top] = -1;
  heap.size -= 1;
  if (heap.size > 0) {
    heapPlace(heap, 0, heap.cells[heap.size]);
    siftDown(heap, 0);
  }
  return top;
}

// ---- Searches ----

export type SearchResult = { path: number[]; energyJ: number; timeS: number };

// Lower bound on energy per horizontal meter of any passable edge:
// W_total >= SANTEE_MIN_LEVEL_FRACTION * W_level, W_level is smallest at the steepest allowed slope,
// surface distance >= horizontal distance, and the terrain multiplier >= the grid minimum.
// So the A* heuristic never overestimates and A* returns the cheapest route.
function minEnergyPerMeterJ(grid: Grid, move: MoveParams): number {
  const steepestRad = Math.min(move.maxSlopeDeg, 90) * DEG;
  const steepestLevelW = santeeLevelWatts(move.massKg, move.speedMPerS, steepestRad);
  return ((SANTEE_MIN_LEVEL_FRACTION * steepestLevelW) / move.speedMPerS) * grid.minTerrainMultiplier;
}

export function straightLineM(grid: Grid, a: number, b: number): number {
  const width = grid.width;
  const dCol = (a % width) - (b % width);
  const dRow = Math.floor(a / width) - Math.floor(b / width);
  return Math.sqrt(dCol * dCol + dRow * dRow) * grid.cellSizeM;
}

// A* point to point, minimum energy.
export function astar(grid: Grid, start: number, goal: number, move: MoveParams): SearchResult | null {
  const endBlocked = grid.terrainCost[start] === grid.impassable || grid.terrainCost[goal] === grid.impassable;
  if (endBlocked) return null;
  if (start === goal) return { path: [start], energyJ: 0, timeS: 0 };

  const cellCount = grid.width * grid.height;
  const energy = new Float64Array(cellCount).fill(Infinity);
  const fScore = new Float64Array(cellCount).fill(Infinity);
  const time = new Float64Array(cellCount);
  const cameFrom = new Int32Array(cellCount).fill(-1);
  const closed = new Uint8Array(cellCount);
  const perMeterJ = minEnergyPerMeterJ(grid, move);
  const heap = createHeap(cellCount, fScore);

  energy[start] = 0;
  fScore[start] = straightLineM(grid, start, goal) * perMeterJ;
  heapPushOrDecrease(heap, start);

  const width = grid.width;
  const height = grid.height;
  while (heap.size > 0) {
    const u = heapPop(heap);
    if (u === goal) return { path: tracePath(cameFrom, goal), energyJ: energy[goal], timeS: time[goal] };
    closed[u] = 1;

    const col = u % width;
    const row = (u - col) / width;
    for (let k = 0; k < 8; k++) {
      const nCol = col + DCOL[k];
      const nRow = row + DROW[k];
      if (nCol < 0 || nCol >= width || nRow < 0 || nRow >= height) continue;
      const v = nRow * width + nCol;
      if (closed[v]) continue;

      const cost = edgeEnergyJ(grid, u, v, move);
      if (cost === Infinity) continue;
      const candidate = energy[u] + cost;
      if (candidate >= energy[v]) continue;

      energy[v] = candidate;
      time[v] = time[u] + slotSurfaceM(grid, u, v, k) / move.speedMPerS;
      cameFrom[v] = u;
      fScore[v] = candidate + straightLineM(grid, v, goal) * perMeterJ;
      heapPushOrDecrease(heap, v);
    }
  }
  return null;
}

function tracePath(cameFrom: Int32Array, goal: number): number[] {
  const path: number[] = [];
  for (let cell = goal; cell !== -1; cell = cameFrom[cell]) path.push(cell);
  return path.reverse();
}

// distanceM: surface length of the minimum-energy path (needed for the rescue carry limit).
// cameFrom: the previous cell on that path (-1 at the source and at cells not reached).
export type FieldResult = { energyJ: Float64Array; timeS: Float64Array; distanceM: Float64Array; cameFrom: Int32Array };

// Dijkstra from one source to all cells.
// reversed = false: energyJ[i] = cost of walking source -> i.
// reversed = true:  energyJ[i] = cost of walking i -> source. Expanding u -> v uses the cost of the edge v -> u,
// because Santee energy is directional and the walk-back is the walk TO the source.
// stopAfter: when given, the search stops once all these cells are settled (their values are final; others may not be).
export function dijkstra(grid: Grid, source: number, move: MoveParams, reversed: boolean, stopAfter: number[] = []): FieldResult {
  const cellCount = grid.width * grid.height;
  const energy = new Float64Array(cellCount).fill(Infinity);
  const time = new Float64Array(cellCount).fill(Infinity);
  const distance = new Float64Array(cellCount).fill(Infinity);
  const closed = new Uint8Array(cellCount);
  const cameFrom = new Int32Array(cellCount).fill(-1);
  const heap = createHeap(cellCount, energy);
  const waiting = new Set(stopAfter);

  energy[source] = 0;
  time[source] = 0;
  distance[source] = 0;
  heapPushOrDecrease(heap, source);

  const width = grid.width;
  const height = grid.height;
  while (heap.size > 0) {
    const u = heapPop(heap);
    closed[u] = 1;
    waiting.delete(u);
    if (stopAfter.length > 0 && waiting.size === 0) break;

    const col = u % width;
    const row = (u - col) / width;
    for (let k = 0; k < 8; k++) {
      const nCol = col + DCOL[k];
      const nRow = row + DROW[k];
      if (nCol < 0 || nCol >= width || nRow < 0 || nRow >= height) continue;
      const v = nRow * width + nCol;
      if (closed[v]) continue;

      const cost = reversed ? edgeEnergyJ(grid, v, u, move) : edgeEnergyJ(grid, u, v, move);
      if (cost === Infinity) continue;
      const candidate = energy[u] + cost;
      if (candidate >= energy[v]) continue;

      // Surface length is the same both ways, so one value serves the reversed search too.
      const surfaceM = slotSurfaceM(grid, u, v, k);
      energy[v] = candidate;
      time[v] = time[u] + surfaceM / move.speedMPerS;
      distance[v] = distance[u] + surfaceM;
      cameFrom[v] = u;
      heapPushOrDecrease(heap, v);
    }
  }
  return { energyJ: energy, timeS: time, distanceM: distance, cameFrom };
}

// The minimum-energy path source -> goal from a forward dijkstra field, or null when the goal was not reached.
export function fieldPath(field: FieldResult, goal: number): number[] | null {
  if (field.energyJ[goal] === Infinity) return null;
  return tracePath(field.cameFrom, goal);
}

// ---- Route statistics ----

// Cumulative values along a path, one entry per cell. maxEdgeSlopeDeg is the steepest edge on it.
export type PathStats = {
  distanceM: Float64Array;
  energyJ: Float64Array;
  timeS: Float64Array;
  maxEdgeSlopeDeg: number;
};

export function pathStats(grid: Grid, path: number[], move: MoveParams): PathStats {
  const distance = new Float64Array(path.length);
  const energy = new Float64Array(path.length);
  const time = new Float64Array(path.length);
  let maxEdgeSlopeDeg = 0;
  for (let i = 1; i < path.length; i++) {
    const from = path[i - 1];
    const to = path[i];
    distance[i] = distance[i - 1] + edgeSurfaceM(grid, from, to);
    energy[i] = energy[i - 1] + edgeEnergyJ(grid, from, to, move);
    time[i] = time[i - 1] + edgeTimeS(grid, from, to, move);
    maxEdgeSlopeDeg = Math.max(maxEdgeSlopeDeg, edgeSlopeDeg(grid, from, to));
  }
  return { distanceM: distance, energyJ: energy, timeS: time, maxEdgeSlopeDeg };
}

// Leg names (docs/data-contract.md, section 4): "habitat", else a site point id at that cell, else "col,row".
export function cellName(grid: Grid, cell: Cell): string {
  const meta = grid.meta;
  const sameCell = (point: Cell) => point.col === cell.col && point.row === cell.row;
  if (sameCell(meta.habitat)) return "habitat";
  const named = [...meta.waypoints, ...meta.shelters, ...meta.roverPickupZones].find(sameCell);
  if (named) return named.id;
  return `${cell.col},${cell.row}`;
}

export function checkCell(grid: Grid, cell: Cell, label: string): void {
  if (!cell || !isInside(grid, cell)) throw new Error(`${label} is not a cell inside the grid`);
}

export function isImpassable(grid: Grid, cell: Cell): boolean {
  return grid.terrainCost[cellIndex(grid, cell)] === grid.impassable;
}

export type RouteRequest = { start?: Cell; end?: Cell; stops: Cell[] };

// One routing function for every case: round trip, one way, to the rover.
// Chains A* legs start -> stop1 -> ... -> end. Missing start or end = habitat.
export function planRoute(grid: Grid, params: Params, request: RouteRequest): Route {
  const habitat = grid.meta.habitat;
  const stops = request.stops ?? [];
  const points = [request.start ?? habitat, ...stops, request.end ?? habitat];
  points.forEach((point, i) => checkCell(grid, point, `route point ${i}`));

  const move = walkingMove(params);
  const reasons: string[] = [];
  const path: number[] = [];
  const legs: RouteLeg[] = [];
  // Path index where each leg ends, for the turn-by-turn steps (a stop always ends a step).
  const legEnds: number[] = [];
  let noPath = false;

  for (const point of points) {
    if (!isImpassable(grid, point)) continue;
    reasons.push(`${cellName(grid, point)} is on an impassable cell`);
    noPath = true;
  }

  for (let i = 0; i + 1 < points.length && !noPath; i++) {
    const fromName = cellName(grid, points[i]);
    const toName = cellName(grid, points[i + 1]);
    const leg = astar(grid, cellIndex(grid, points[i]), cellIndex(grid, points[i + 1]), move);
    if (!leg) {
      reasons.push(`No walkable path from ${fromName} to ${toName}`);
      noPath = true;
      break;
    }
    const legStats = pathStats(grid, leg.path, move);
    const last = leg.path.length - 1;
    legs.push({
      from: fromName,
      to: toName,
      distanceM: legStats.distanceM[last],
      energyJ: legStats.energyJ[last],
      timeS: legStats.timeS[last],
    });
    // Each leg starts on the cell where the previous one ended. Keep that cell once.
    const firstNew = path.length === 0 ? 0 : 1;
    for (let j = firstNew; j < leg.path.length; j++) path.push(leg.path[j]);
    legEnds.push(path.length - 1);
  }

  const stats = pathStats(grid, path, move);
  const lastIndex = path.length - 1;
  // Time at each stop (not at the start or end), at the station-work rate (docs/assumptions.md, section "Engine").
  const stopTimeS = stops.length * params.STOP_DWELL_MIN * SECONDS_PER_MINUTE;
  const stopEnergyJ = stopTimeS * params.STATION_WORK_W;
  const totalEnergyJ = (lastIndex >= 0 ? stats.energyJ[lastIndex] : 0) + stopEnergyJ;
  const totalTimeS = (lastIndex >= 0 ? stats.timeS[lastIndex] : 0) + stopTimeS;
  const elevationProfile = path.map((cell, i) => ({ distanceM: stats.distanceM[i], elevationM: grid.elevation[cell] }));

  let verdict: Route["verdict"] = "NO_GO";
  if (!noPath) verdict = routeVerdict(grid, params, path, stats, totalEnergyJ, totalTimeS, reasons);

  return {
    type: "route",
    path: path.map((cell) => cellAt(grid, cell)),
    legs,
    stopTimeS,
    stopEnergyJ,
    totalEnergyJ,
    totalTimeS,
    elevationProfile,
    verdict,
    reasons,
    instructions: noPath ? [] : routeInstructions(grid, params, path, stats, legEnds, legs),
  };
}

// ---- Turn-by-turn instructions (docs/data-contract.md, section 4.2) ----

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const COMPASS_STEP_DEG = 45;
const FULL_TURN_DEG = 360;
const HALF_TURN_DEG = 180;

// Compass bearing from cell a to cell b: 0 = north (row 0 is the north edge), 90 = east.
function bearingDeg(grid: Grid, a: number, b: number): number {
  const from = cellAt(grid, a);
  const to = cellAt(grid, b);
  const deg = Math.atan2(to.col - from.col, from.row - to.row) / DEG;
  return (deg + FULL_TURN_DEG) % FULL_TURN_DEG;
}

function headingChangeDeg(a: number, b: number): number {
  const diff = Math.abs(a - b) % FULL_TURN_DEG;
  return diff > HALF_TURN_DEG ? FULL_TURN_DEG - diff : diff;
}

// Horizontal distance (m) of cell p from the straight line a-b.
function offLineM(grid: Grid, p: number, a: number, b: number): number {
  const pa = cellAt(grid, a);
  const pb = cellAt(grid, b);
  const pp = cellAt(grid, p);
  const dx = pb.col - pa.col;
  const dy = pb.row - pa.row;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(pp.col - pa.col, pp.row - pa.row) * grid.cellSizeM;
  return (Math.abs(dx * (pa.row - pp.row) - dy * (pa.col - pp.col)) / length) * grid.cellSizeM;
}

// Douglas-Peucker on path[first..last]: the path indices of the corners. An 8-connected path zigzags (N, NE, N, ...)
// to follow a straight line, so raw edge headings jump by 45 deg. Points within one cell of the line are not corners:
// a cell is the grid's own resolution (ROUTING_CELL_SIZE_M).
function corners(grid: Grid, path: number[], first: number, last: number): number[] {
  const keep = [first, last];
  const spans: [number, number][] = [[first, last]];
  while (spans.length > 0) {
    const [a, b] = spans.pop() as [number, number];
    let farthest = -1;
    let farthestM = grid.cellSizeM;
    for (let i = a + 1; i < b; i++) {
      const offM = offLineM(grid, path[i], path[a], path[b]);
      if (offM > farthestM) {
        farthest = i;
        farthestM = offM;
      }
    }
    if (farthest < 0) continue;
    keep.push(farthest);
    spans.push([a, farthest], [farthest, b]);
  }
  return keep.sort((x, y) => x - y);
}

function routeInstructions(
  grid: Grid,
  params: Params,
  path: number[],
  stats: PathStats,
  legEnds: number[],
  legs: RouteLeg[],
): Instruction[] {
  // Step boundaries: each leg end, and each corner where the heading turns more than TURN_ANGLE_DEG from the
  // heading of the first segment of the current step, and stays turned: the segment after it also differs by more
  // than TURN_ANGLE_DEG (or the leg ends). A single jog around an obstacle that comes back to the heading is not a turn.
  const bounds: number[] = [0];
  let legStart = 0;
  for (const legEnd of legEnds) {
    const legCorners = corners(grid, path, legStart, legEnd);
    const segmentHeading = (k: number) => bearingDeg(grid, path[legCorners[k]], path[legCorners[k + 1]]);
    const segmentCount = legCorners.length - 1;
    let stepHeading = segmentHeading(0);
    for (let k = 1; k < segmentCount; k++) {
      const turned = headingChangeDeg(segmentHeading(k), stepHeading) > TURN_ANGLE_DEG;
      const isLastSegment = k + 1 === segmentCount;
      const staysTurned = isLastSegment || headingChangeDeg(segmentHeading(k + 1), stepHeading) > TURN_ANGLE_DEG;
      if (!turned || !staysTurned) continue;
      bounds.push(legCorners[k]);
      stepHeading = segmentHeading(k);
    }
    if (legEnd > bounds[bounds.length - 1]) bounds.push(legEnd);
    legStart = legEnd;
  }

  const instructions: Instruction[] = [];
  for (let s = 0; s + 1 < bounds.length; s++) {
    const start = bounds[s];
    const end = bounds[s + 1];
    const direction = COMPASS[Math.round(bearingDeg(grid, path[start], path[end]) / COMPASS_STEP_DEG) % COMPASS.length];
    const distanceM = stats.distanceM[end] - stats.distanceM[start];
    const legIndex = legEnds.indexOf(end);
    const target = legIndex >= 0 ? ` to ${legs[legIndex].to}` : "";
    const instruction: Instruction = { text: `Head ${direction} for ${Math.round(distanceM)} m${target}`, direction, distanceM, cellIndex: start };
    let steepestDeg = 0;
    for (let i = start; i < end; i++) steepestDeg = Math.max(steepestDeg, edgeSlopeDeg(grid, path[i], path[i + 1]));
    if (steepestDeg > params.CAUTION_SLOPE_DEG) instruction.warning = `Caution slope (${params.CAUTION_SLOPE_DEG}-${params.MAX_SLOPE_DEG} deg)`;
    instructions.push(instruction);
  }
  return instructions;
}

// Rules: docs/assumptions.md, section "Engine". Adds one reason line per trigger.
function routeVerdict(
  grid: Grid,
  params: Params,
  path: number[],
  stats: PathStats,
  totalEnergyJ: number,
  totalTimeS: number,
  reasons: string[],
): Route["verdict"] {
  const budgetJ = energyBudgetJ(params);
  const reserveLimitJ = budgetJ * (1 - params.RESERVE_FRACTION);
  const evaS = params.EVA_DURATION_H * SECONDS_PER_HOUR;
  const habitat = cellIndex(grid, grid.meta.habitat);

  let farthestM = 0;
  let lowConfidenceCells = 0;
  for (const cell of path) {
    farthestM = Math.max(farthestM, straightLineM(grid, cell, habitat));
    if (grid.demQuality[cell] === 1) lowConfidenceCells += 1;
  }

  const noGoReasons: string[] = [];
  if (totalEnergyJ > budgetJ) {
    noGoReasons.push(`Route energy ${mj(totalEnergyJ)} MJ is above the EVA energy budget ${mj(budgetJ)} MJ`);
  }
  if (totalTimeS > evaS) {
    noGoReasons.push(`Route time ${hours(totalTimeS)} h is above the EVA duration ${params.EVA_DURATION_H} h`);
  }
  if (farthestM > params.MAX_WALK_RADIUS_M) {
    noGoReasons.push(`Route goes ${Math.round(farthestM)} m from the habitat, beyond the ${params.MAX_WALK_RADIUS_M} m walk radius`);
  }
  if (noGoReasons.length > 0) {
    reasons.push(...noGoReasons);
    return "NO_GO";
  }

  const cautionReasons: string[] = [];
  if (stats.maxEdgeSlopeDeg > params.CAUTION_SLOPE_DEG) {
    cautionReasons.push(`Route has slopes up to ${stats.maxEdgeSlopeDeg.toFixed(1)} deg, above the ${params.CAUTION_SLOPE_DEG} deg caution slope`);
  }
  if (lowConfidenceCells > 0) {
    cautionReasons.push(`Route crosses ${lowConfidenceCells} low-confidence elevation cells`);
  }
  if (totalEnergyJ > reserveLimitJ) {
    cautionReasons.push(`Route energy ${mj(totalEnergyJ)} MJ uses the ${Math.round(params.RESERVE_FRACTION * 100)}% reserve (limit ${mj(reserveLimitJ)} MJ)`);
  }
  reasons.push(...cautionReasons);
  return cautionReasons.length > 0 ? "CAUTION" : "GO";
}

function mj(joules: number): string {
  return (joules / 1e6).toFixed(2);
}

function hours(seconds: number): string {
  return (seconds / SECONDS_PER_HOUR).toFixed(2);
}

// ---- Walk-back envelope ----

export type WalkbackRequest = { elapsedS: number; usedJ: number; returnPoint?: Cell; position?: Cell };

// Rules: docs/assumptions.md, section "Engine" (mask levels and turn-back time).
// `move` is the walking move, or the rescue move for the buddy-injured envelope (docs/data-contract.md, section 4.1).
// A cell whose return path is longer than move.maxPathM cannot return (the rescue carry limit).
export function walkback(grid: Grid, params: Params, request: WalkbackRequest, move: MoveParams = walkingMove(params)): Envelope {
  const returnPoint = request.returnPoint ?? grid.meta.habitat;
  const position = request.position ?? returnPoint;
  checkCell(grid, returnPoint, "returnPoint");
  checkCell(grid, position, "position");
  if (isImpassable(grid, returnPoint)) throw new Error("returnPoint is on an impassable cell");
  const inputsValid = Number.isFinite(request.elapsedS) && Number.isFinite(request.usedJ);
  if (!inputsValid) throw new Error("elapsedS and usedJ must be numbers");

  const toReturn = dijkstra(grid, cellIndex(grid, returnPoint), move, true);

  const budgetJ = energyBudgetJ(params);
  const safeLimitJ = budgetJ * (1 - params.RESERVE_FRACTION);
  const evaS = params.EVA_DURATION_H * SECONDS_PER_HOUR;
  const mask = new Uint8Array(grid.width * grid.height);
  for (let i = 0; i < mask.length; i++) {
    const returnJ = toReturn.energyJ[i];
    const pathTooLong = toReturn.distanceM[i] > move.maxPathM;
    if (returnJ === Infinity || pathTooLong) continue;
    const returnTimeFits = request.elapsedS + toReturn.timeS[i] <= evaS;
    if (!returnTimeFits) continue;
    const totalJ = request.usedJ + returnJ;
    if (totalJ <= safeLimitJ) mask[i] = 2;
    else if (totalJ <= budgetJ) mask[i] = 1;
  }

  const positionIndex = cellIndex(grid, position);
  const positionReturnJ = toReturn.energyJ[positionIndex];
  const positionReturnS = toReturn.timeS[positionIndex];
  const positionCanReturn = positionReturnJ !== Infinity && toReturn.distanceM[positionIndex] <= move.maxPathM;
  let turnBackAtS = request.elapsedS;
  if (positionCanReturn) {
    // Energy slack is spent at STATION_WORK_W while the crew stays at `position` (ASSUMPTION).
    const energySlackJ = safeLimitJ - request.usedJ - positionReturnJ;
    const timeSlackS = evaS - request.elapsedS - positionReturnS;
    const slackS = Math.min(timeSlackS, energySlackJ / params.STATION_WORK_W);
    turnBackAtS = request.elapsedS + Math.max(0, slackS);
  }

  return { type: "envelope", mask, remainingJ: budgetJ - request.usedJ, turnBackAtS };
}

// ---- Shelter times ----

// The meta.json shelters, fastest first. Terrain "partial" shelters are not returned yet (docs/data-contract.md, section 4).
// Each path is the minimum-energy path; timeS is the walking time along it.
export function shelterTimes(grid: Grid, params: Params, from: Cell): ShelterTimes {
  checkCell(grid, from, "from");
  if (isImpassable(grid, from)) throw new Error("from is on an impassable cell");
  const move = walkingMove(params);
  const start = cellIndex(grid, from);

  const options: ShelterTimes["options"] = [];
  for (const shelter of grid.meta.shelters) {
    const result = astar(grid, start, cellIndex(grid, shelter), move);
    if (!result) continue;
    options.push({
      shelterId: shelter.id,
      kind: shelter.kind,
      timeS: result.timeS,
      path: result.path.map((cell) => cellAt(grid, cell)),
    });
  }
  options.sort((a, b) => a.timeS - b.timeS || (a.shelterId < b.shelterId ? -1 : 1));
  return { type: "shelterTimes", options };
}
