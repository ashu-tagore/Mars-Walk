// Phase 4: science planner and contingency simulator. Rules: docs/data-contract.md, section 4.1.
// Built on the searches in engine.ts. No DOM, no app state: every reply depends only on the grid, params and request.

import { SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from "./constants";
import {
  Envelope,
  MoveParams,
  Params,
  Route,
  SearchResult,
  astar,
  cellName,
  checkCell,
  energyBudgetJ,
  pathStats,
  planRoute,
  rescueMove,
  straightLineM,
  walkback,
  walkingMove,
} from "./engine";
import { Cell, Grid, cellAt, cellIndex } from "./grid";

// ---- Contract types (docs/data-contract.md, section 4) ----

export type SciencePlan = {
  type: "sciencePlan";
  stops: Cell[];
  stopIds: string[];
  totalValue: number;
  route: Route;
};

export type AstronautId = "A" | "B";

export type SimState = {
  type: "simState";
  scenario: string;
  timeS: number;
  astronauts: { id: AstronautId; cell: Cell; status: "ok" | "injured" | "rescuer"; usedJ: number }[];
  separationM: number;
  envelope: Envelope;
  recommendedAction: "continue" | "return" | "go_to_shelter" | "go_to_rover_pickup";
  actionPath: Cell[];
  actionTargetId: string | null;
  actionTimeS: number;
  actionEnergyJ: number;
  warnings: string[];
};

// ---- Science planner ----

export type ScienceRequest = { budgetJ?: number; maxStops?: number };

type Leg = { energyJ: number; timeS: number; farthestM: number };

const NO_LEG: Leg = { energyJ: Infinity, timeS: Infinity, farthestM: Infinity };

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// Greedy: add the waypoint with the best scienceValue per added joule while the plan stays inside the limits.
export function planScience(grid: Grid, params: Params, request: ScienceRequest = {}): SciencePlan {
  const budgetJ = request.budgetJ ?? energyBudgetJ(params);
  if (!isNonNegativeNumber(budgetJ)) throw new Error("budgetJ must be a number >= 0");
  // Sorted by id, so a strict "better than" comparison keeps the smaller id on a tie.
  const candidates = [...grid.meta.waypoints].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const maxStops = request.maxStops ?? candidates.length;
  const maxStopsValid = Number.isInteger(maxStops) && maxStops >= 0;
  if (!maxStopsValid) throw new Error("maxStops must be a whole number >= 0");

  // Point 0 is the habitat, point i > 0 is candidates[i - 1]. Legs are directional (Santee).
  const habitat = grid.meta.habitat;
  const points: Cell[] = [habitat, ...candidates];
  points.forEach((point, i) => checkCell(grid, point, `science point ${i}`));
  const legs = legMatrix(grid, walkingMove(params), points);
  // Each stop also takes STOP_DWELL_MIN at STATION_WORK_W, so a stop adds that energy on top of its walk.
  const stopTimeS = params.STOP_DWELL_MIN * SECONDS_PER_MINUTE;
  const stop = { timeS: stopTimeS, energyJ: stopTimeS * params.STATION_WORK_W };
  const totalsOf = (tour: number[]) => tourTotals(legs, tour, stop);

  const limitJ = budgetJ * (1 - params.RESERVE_FRACTION);
  const evaS = params.EVA_DURATION_H * SECONDS_PER_HOUR;
  const fits = (tour: number[]) => {
    const totals = totalsOf(tour);
    return totals.energyJ <= limitJ && totals.timeS <= evaS && totals.farthestM <= params.MAX_WALK_RADIUS_M;
  };

  let tour = [0, 0];
  while (tour.length - 2 < maxStops) {
    const tourJ = totalsOf(tour).energyJ;
    let best: { tour: number[]; ratio: number } | null = null;
    for (let c = 1; c < points.length; c++) {
      if (tour.includes(c)) continue;
      const insertion = cheapestInsertion(tour, c, totalsOf, fits);
      if (!insertion) continue;
      const addedJ = totalsOf(insertion).energyJ - tourJ;
      const value = candidates[c - 1].scienceValue;
      // addedJ includes the stop energy, so it is above 0 whenever STOP_DWELL_MIN is.
      const ratio = addedJ > 0 ? value / addedJ : Infinity;
      if (!best || ratio > best.ratio) best = { tour: insertion, ratio };
    }
    if (!best) break;
    tour = best.tour;
  }

  const chosen = tour.slice(1, -1).map((i) => candidates[i - 1]);
  const stops = chosen.map((point) => ({ col: point.col, row: point.row }));
  return {
    type: "sciencePlan",
    stops,
    stopIds: chosen.map((point) => point.id),
    totalValue: chosen.reduce((sum, point) => sum + point.scienceValue, 0),
    route: planRoute(grid, params, { stops }),
  };
}

function legMatrix(grid: Grid, move: MoveParams, points: Cell[]): Leg[][] {
  const habitat = cellIndex(grid, grid.meta.habitat);
  return points.map((from) =>
    points.map((to) => {
      const result = astar(grid, cellIndex(grid, from), cellIndex(grid, to), move);
      if (!result) return NO_LEG;
      const farthestM = Math.max(...result.path.map((cell) => straightLineM(grid, cell, habitat)));
      return { energyJ: result.energyJ, timeS: result.timeS, farthestM };
    }),
  );
}

// Walking legs plus the time and energy at each stop (every tour point except the first and last).
function tourTotals(legs: Leg[][], tour: number[], stop: { timeS: number; energyJ: number }): Leg {
  const stopCount = tour.length - 2;
  const totals = { energyJ: stopCount * stop.energyJ, timeS: stopCount * stop.timeS, farthestM: 0 };
  for (let i = 0; i + 1 < tour.length; i++) {
    const leg = legs[tour[i]][tour[i + 1]];
    totals.energyJ += leg.energyJ;
    totals.timeS += leg.timeS;
    totals.farthestM = Math.max(totals.farthestM, leg.farthestM);
  }
  return totals;
}

// The tour with point c inserted where it adds the least energy, among the places that fit. Ties: the earlier place.
function cheapestInsertion(
  tour: number[],
  c: number,
  totalsOf: (tour: number[]) => Leg,
  fits: (tour: number[]) => boolean,
): number[] | null {
  let best: number[] | null = null;
  let bestJ = Infinity;
  for (let place = 1; place < tour.length; place++) {
    const candidate = [...tour.slice(0, place), c, ...tour.slice(place)];
    const energyJ = totalsOf(candidate).energyJ;
    if (energyJ >= bestJ || !fits(candidate)) continue;
    best = candidate;
    bestJ = energyJ;
  }
  return best;
}

// ---- Contingency simulator ----

export type SimRequest = {
  scenario: string;
  atTimeS: number;
  astronaut: AstronautId;
  stops: Cell[];
  start?: Cell;
  end?: Cell;
  delaysS?: { A?: number; B?: number };
};

const SCENARIOS = ["none", "sep_event", "buddy_injured"];

type Crewmember = { id: AstronautId; cell: number; usedJ: number };

// The part of SimState that each scenario decides.
type Outcome = {
  envelope: Envelope;
  action: SimState["recommendedAction"];
  path: number[];
  targetId: string | null;
  timeS: number;
  energyJ: number;
  injuredId: AstronautId | null;
};

export function simulate(grid: Grid, params: Params, request: SimRequest): SimState {
  if (!SCENARIOS.includes(request.scenario)) throw new Error(`scenario must be one of ${SCENARIOS.join(", ")}`);
  if (request.astronaut !== "A" && request.astronaut !== "B") throw new Error('astronaut must be "A" or "B"');
  if (!Number.isFinite(request.atTimeS)) throw new Error("atTimeS must be a number");
  const delayA = request.delaysS?.A ?? 0;
  const delayB = request.delaysS?.B ?? 0;
  if (!isNonNegativeNumber(delayA) || !isNonNegativeNumber(delayB)) throw new Error("delaysS must be numbers >= 0");

  const stops = request.stops ?? [];
  const plan = planRoute(grid, params, { start: request.start, end: request.end, stops });
  const planComplete = plan.legs.length === stops.length + 1;
  if (!planComplete) throw new Error(plan.reasons[0] ?? "no walkable path for the plan");

  // Both astronauts follow the plan route, each one delaysS behind it, and stay STOP_DWELL_MIN at each stop.
  const path = plan.path.map((cell) => cellIndex(grid, cell));
  const timeline = stopTimeline(grid, params, path, stops);
  const positionAt = (id: AstronautId, delayS: number): Crewmember => {
    const t = request.atTimeS - delayS;
    let i = 0;
    while (i + 1 < path.length && timeline.arriveS[i + 1] <= t) i++;
    const timeHereS = Math.min(Math.max(t - timeline.arriveS[i], 0), timeline.stayS[i]);
    return { id, cell: path[i], usedJ: timeline.arriveJ[i] + timeHereS * params.STATION_WORK_W };
  };
  const crewA = positionAt("A", delayA);
  const crewB = positionAt("B", delayB);
  const self = request.astronaut === "A" ? crewA : crewB;
  const other = request.astronaut === "A" ? crewB : crewA;

  const warnings: string[] = [];
  const separationM = straightLineM(grid, crewA.cell, crewB.cell);
  if (separationM > params.BUDDY_MAX_SEPARATION_M) {
    warnings.push(`Buddy separation ${Math.round(separationM)} m is above the ${params.BUDDY_MAX_SEPARATION_M} m limit`);
  }

  let outcome: Outcome;
  if (request.scenario === "sep_event") outcome = sepEvent(grid, params, request.atTimeS, self, crewA, crewB, warnings);
  else if (request.scenario === "buddy_injured") outcome = buddyInjured(grid, params, request.atTimeS, self, other, warnings);
  else outcome = noEvent(grid, params, request.atTimeS, self, warnings);

  const statusOf = (id: AstronautId): "ok" | "injured" | "rescuer" => {
    if (outcome.injuredId === null) return "ok";
    return id === outcome.injuredId ? "injured" : "rescuer";
  };
  return {
    type: "simState",
    scenario: request.scenario,
    timeS: request.atTimeS,
    astronauts: [crewA, crewB].map((crew) => ({
      id: crew.id,
      cell: cellAt(grid, crew.cell),
      status: statusOf(crew.id),
      usedJ: crew.usedJ,
    })),
    separationM,
    envelope: outcome.envelope,
    recommendedAction: outcome.action,
    actionPath: outcome.path.map((cell) => cellAt(grid, cell)),
    actionTargetId: outcome.targetId,
    actionTimeS: outcome.timeS,
    actionEnergyJ: outcome.energyJ,
    warnings,
  };
}

// Arrival time and energy at each route cell, counting STOP_DWELL_MIN at each stop already left,
// and how long the crew stays at that cell (STOP_DWELL_MIN per stop there, else 0).
function stopTimeline(grid: Grid, params: Params, path: number[], stops: Cell[]) {
  const walk = pathStats(grid, path, walkingMove(params));
  const dwellS = params.STOP_DWELL_MIN * SECONDS_PER_MINUTE;
  const stayS = new Float64Array(path.length);
  // Each leg ends on its stop, so the first match after the previous stop is that stop's place on the path.
  let from = 0;
  for (const stop of stops) {
    const target = cellIndex(grid, stop);
    let i = from;
    while (path[i] !== target) i++;
    stayS[i] += dwellS;
    from = i;
  }
  const arriveS = new Float64Array(path.length);
  const arriveJ = new Float64Array(path.length);
  let stayedS = 0;
  for (let i = 0; i < path.length; i++) {
    arriveS[i] = walk.timeS[i] + stayedS;
    arriveJ[i] = walk.energyJ[i] + stayedS * params.STATION_WORK_W;
    stayedS += stayS[i];
  }
  return { arriveS, arriveJ, stayS };
}

function noEvent(grid: Grid, params: Params, atTimeS: number, self: Crewmember, warnings: string[]): Outcome {
  const envelope = walkback(grid, params, { elapsedS: atTimeS, usedJ: self.usedJ, position: cellAt(grid, self.cell) });
  const action = atTimeS < envelope.turnBackAtS ? "continue" : "return";
  const home = astar(grid, self.cell, cellIndex(grid, grid.meta.habitat), walkingMove(params));
  if (!home) warnings.push(`No walkable path from ${cellName(grid, cellAt(grid, self.cell))} to the habitat`);
  return { envelope, action, injuredId: null, targetId: "habitat", ...pathFields(home) };
}

// The crew stays together: the chosen shelter is the one where the later of the two arrives first.
function sepEvent(
  grid: Grid,
  params: Params,
  atTimeS: number,
  self: Crewmember,
  crewA: Crewmember,
  crewB: Crewmember,
  warnings: string[],
): Outcome {
  const move = walkingMove(params);
  let best: { id: string; cell: Cell; laterS: number; selfPath: SearchResult } | null = null;
  for (const shelter of grid.meta.shelters) {
    const target = cellIndex(grid, shelter);
    const pathA = astar(grid, crewA.cell, target, move);
    const pathB = astar(grid, crewB.cell, target, move);
    if (!pathA || !pathB) continue;
    const laterS = Math.max(pathA.timeS, pathB.timeS);
    const better = !best || laterS < best.laterS || (laterS === best.laterS && shelter.id < best.id);
    if (!better) continue;
    best = { id: shelter.id, cell: shelter, laterS, selfPath: self.id === "A" ? pathA : pathB };
  }

  warnings.push("Charged particles can arrive in tens of minutes (SEP_ARRIVAL)");
  const position = cellAt(grid, self.cell);
  if (!best) {
    warnings.push("No full shelter is reachable on foot by both crewmembers");
    const envelope = walkback(grid, params, { elapsedS: atTimeS, usedJ: self.usedJ, position });
    return { envelope, action: "go_to_shelter", injuredId: null, targetId: null, ...pathFields(null) };
  }

  const targetS = params.SEP_SHELTER_TARGET_MIN * SECONDS_PER_MINUTE;
  if (best.laterS > targetS) {
    warnings.push(`The crew needs ${minutes(best.laterS)} min to reach ${best.id}, above the ${params.SEP_SHELTER_TARGET_MIN} min shelter target`);
  }
  const envelope = walkback(grid, params, { elapsedS: atTimeS, usedJ: self.usedJ, returnPoint: best.cell, position });
  return { envelope, action: "go_to_shelter", injuredId: null, targetId: best.id, ...pathFields(best.selfPath) };
}

type RescueOption = { id: string; carry: SearchResult; totalTimeS: number; failedLimits: string[] };

// `self` is the rescuer, `injured` the other crewmember. Walk to the injured cell, then carry (rescue move).
function buddyInjured(
  grid: Grid,
  params: Params,
  atTimeS: number,
  self: Crewmember,
  injured: Crewmember,
  warnings: string[],
): Outcome {
  warnings.push("The injured crewmember's own consumables are not modeled");
  const carryMove = rescueMove(params);
  const walk = astar(grid, self.cell, injured.cell, walkingMove(params));
  const elapsedS = atTimeS + (walk ? walk.timeS : 0);
  const usedJ = self.usedJ + (walk ? walk.energyJ : 0);
  const envelope = walkback(grid, params, { elapsedS, usedJ, position: cellAt(grid, injured.cell) }, carryMove);
  const base = { envelope, injuredId: injured.id };
  if (!walk) {
    warnings.push("No walkable path from the rescuer to the injured crewmember");
    return { ...base, action: "go_to_rover_pickup", targetId: null, ...pathFields(null) };
  }

  const budgetJ = energyBudgetJ(params);
  const evaS = params.EVA_DURATION_H * SECONDS_PER_HOUR;
  const option = (id: string, cell: Cell): RescueOption | null => {
    const carry = astar(grid, injured.cell, cellIndex(grid, cell), carryMove);
    if (!carry) return null;
    const carryM = pathStats(grid, carry.path, carryMove).distanceM[carry.path.length - 1];
    const failedLimits: string[] = [];
    if (usedJ + carry.energyJ > budgetJ) failedLimits.push("the EVA energy budget");
    if (elapsedS + carry.timeS > evaS) failedLimits.push("the EVA duration");
    if (carryM > carryMove.maxPathM) failedLimits.push(`the ${carryMove.maxPathM} m rescue distance`);
    return { id, carry, totalTimeS: walk.timeS + carry.timeS, failedLimits };
  };

  const home = option("habitat", grid.meta.habitat);
  if (home && home.failedLimits.length === 0) {
    return { ...base, action: "return", targetId: "habitat", ...rescueFields(walk, home.carry) };
  }
  if (home) warnings.push(`Carrying the injured crewmember to the habitat exceeds ${home.failedLimits.join(", ")}`);
  else warnings.push("No walkable path from the injured crewmember to the habitat");

  const pickups = grid.meta.roverPickupZones
    .map((zone) => option(zone.id, zone))
    .filter((zone): zone is RescueOption => zone !== null)
    .sort((a, b) => a.totalTimeS - b.totalTimeS || (a.id < b.id ? -1 : 1));
  const feasible = pickups.find((zone) => zone.failedLimits.length === 0);
  const chosen = feasible ?? pickups[0];
  if (!chosen) {
    warnings.push("No rover pickup zone is reachable");
    return { ...base, action: "go_to_rover_pickup", targetId: null, ...pathFields(null) };
  }
  if (!feasible) warnings.push(`No rover pickup zone fits the limits. ${chosen.id} exceeds ${chosen.failedLimits.join(", ")}`);
  warnings.push("Rover driving to the pickup zone is not modeled");
  return { ...base, action: "go_to_rover_pickup", targetId: chosen.id, ...rescueFields(walk, chosen.carry) };
}

function pathFields(result: SearchResult | null): { path: number[]; timeS: number; energyJ: number } {
  if (!result) return { path: [], timeS: 0, energyJ: 0 };
  return { path: result.path, timeS: result.timeS, energyJ: result.energyJ };
}

// Walk path then carry path. The injured cell ends the first and starts the second: keep it once.
function rescueFields(walk: SearchResult, carry: SearchResult): { path: number[]; timeS: number; energyJ: number } {
  return {
    path: [...walk.path, ...carry.path.slice(1)],
    timeS: walk.timeS + carry.timeS,
    energyJ: walk.energyJ + carry.energyJ,
  };
}

function minutes(seconds: number): string {
  return (seconds / SECONDS_PER_MINUTE).toFixed(0);
}
