import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EVA_DURATION_H,
  SCIENCE_PEAK_COUNT,
  SCIENCE_STOP_MIN_SPACING_M,
  SECONDS_PER_HOUR,
  SECONDS_PER_MINUTE,
  SHIELD_PARTIAL_MAX_SKY,
} from "../src/constants";
import {
  Params,
  applyParams,
  astar,
  defaultParams,
  dijkstra,
  energyBudgetJ,
  pathStats,
  planRoute,
  rescueMove,
  straightLineM,
  walkingMove,
} from "../src/engine";
import { Grid, Meta, cellIndex, parseSite } from "../src/grid";
import { SimRequest, SimState, planScience, sciencePeaks, simulate } from "../src/mission";
import { createState, handleMessage } from "../src/worker";
import { makeFixtureSite } from "./fixtures";

function fixtureGrid(): Grid {
  const site = makeFixtureSite();
  return parseSite(site.meta, site.files);
}

function maskCount(mask: Uint8Array, minLevel: number): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] >= minLevel) count += 1;
  return count;
}

// Plan habitat -> s1 -> habitat, at the moment the crew arrives at s1 (no dwell time, so that is the end of leg 0).
function atFirstStop(grid: Grid, params: Params, scenario: string, extra: Partial<SimRequest> = {}): SimState {
  const stops = [grid.meta.waypoints[0]];
  const arrivalS = planRoute(grid, params, { stops }).legs[0].timeS;
  return simulate(grid, params, { scenario, atTimeS: arrivalS, astronaut: "A", stops, ...extra });
}

function expectNoImpassableCell(grid: Grid, state: SimState): void {
  for (const cell of state.actionPath) expect(grid.terrainCost[cellIndex(grid, cell)]).not.toBe(grid.impassable);
}

describe("simulate: timeline and buddy separation", () => {
  it("equal delays keep the crew together, a delayed buddy triggers the separation warning", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const stops = grid.meta.waypoints;
    const together = simulate(grid, params, { scenario: "none", atTimeS: 600, astronaut: "A", stops });
    expect(together.separationM).toBe(0);
    expect(together.warnings.some((line) => line.includes("separation"))).toBe(false);

    const apart = simulate(grid, params, { scenario: "none", atTimeS: 600, astronaut: "A", stops, delaysS: { B: 300 } });
    expect(apart.separationM).toBeGreaterThan(params.BUDDY_MAX_SEPARATION_M);
    expect(apart.warnings.some((line) => line.includes("separation"))).toBe(true);
    const [a, b] = apart.astronauts;
    expect(b.usedJ).toBeLessThan(a.usedJ);
  });

  it("the crew stays STOP_DWELL_MIN at a stop and uses STATION_WORK_W there", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const stop = grid.meta.waypoints[0];
    const stopCell = { col: stop.col, row: stop.row };
    const arrival = atFirstStop(grid, params, "none");
    const dwellS = params.STOP_DWELL_MIN * SECONDS_PER_MINUTE;
    const halfway = atFirstStop(grid, params, "none", { atTimeS: arrival.timeS + dwellS / 2 });
    expect(halfway.astronauts[0].cell).toEqual(stopCell);
    expect(halfway.astronauts[0].usedJ).toBeCloseTo(arrival.astronauts[0].usedJ + (dwellS / 2) * params.STATION_WORK_W, 6);
    const afterStop = atFirstStop(grid, params, "none", { atTimeS: arrival.timeS + dwellS + 60 });
    expect(afterStop.astronauts[0].cell).not.toEqual(stopCell);
  });

  it("STOP_DWELL_MIN = 0 gives a walking-only route", () => {
    const grid = fixtureGrid();
    const params = applyParams(defaultParams(), { STOP_DWELL_MIN: 0 });
    const route = planRoute(grid, params, { stops: grid.meta.waypoints });
    expect(route.stopTimeS).toBe(0);
    expect(route.totalTimeS).toBeCloseTo(route.legs.reduce((sum, leg) => sum + leg.timeS, 0), 6);
  });

  it("before the start the crew is at the start, after the end at the end", () => {
    const grid = fixtureGrid();
    const habitat = grid.meta.habitat;
    const stops = [grid.meta.waypoints[0]];
    for (const atTimeS of [-100, 1e6]) {
      const state = simulate(grid, defaultParams(), { scenario: "none", atTimeS, astronaut: "A", stops });
      expect(state.astronauts[0].cell).toEqual({ col: habitat.col, row: habitat.row });
    }
  });

  it('scenario "none": continue early, return once the turn-back time has passed', () => {
    const grid = fixtureGrid();
    const early = atFirstStop(grid, defaultParams(), "none");
    expect(early.recommendedAction).toBe("continue");
    expect(early.actionTargetId).toBe("habitat");
    const late = atFirstStop(grid, defaultParams(), "none", { atTimeS: EVA_DURATION_H * SECONDS_PER_HOUR });
    expect(late.recommendedAction).toBe("return");
  });
});

describe("simulate: buddy injured", () => {
  it("buddy-rescue route cost >= normal route cost for the same path (CLAUDE.md)", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const state = atFirstStop(grid, params, "buddy_injured");
    expect(state.recommendedAction).toBe("return");
    expect(state.astronauts.map((crew) => crew.status)).toEqual(["rescuer", "injured"]);
    const cells = state.actionPath.map((cell) => cellIndex(grid, cell));
    const normalJ = pathStats(grid, cells, walkingMove(params)).energyJ[cells.length - 1];
    expect(state.actionEnergyJ).toBeGreaterThanOrEqual(normalJ);
    expectNoImpassableCell(grid, state);
  });

  it("the rescue envelope is smaller than the walking envelope at the same moment", () => {
    const grid = fixtureGrid();
    // The fixture is small: with the full budget every cell is in both envelopes. A budget of the energy used so far
    // plus two walks home from s1 makes the limit bite, so the heavier, slower rescue move must reach fewer cells.
    const base = defaultParams();
    const leg = planRoute(grid, base, { stops: [grid.meta.waypoints[0]] }).legs;
    const params = applyParams(base, { EVA_ENERGY_BUDGET_J: leg[0].energyJ + 2 * leg[1].energyJ });
    const walking = atFirstStop(grid, params, "none");
    const rescue = atFirstStop(grid, params, "buddy_injured");
    expect(maskCount(walking.envelope.mask, 1)).toBeLessThan(grid.width * grid.height);
    expect(maskCount(rescue.envelope.mask, 1)).toBeLessThan(maskCount(walking.envelope.mask, 1));
  });

  it("falls back to the rover pickup zone when the habitat is beyond the energy budget", () => {
    const grid = fixtureGrid();
    const base = defaultParams();
    const injuredCell = cellIndex(grid, grid.meta.waypoints[0]);
    const pickup = grid.meta.roverPickupZones[0];
    const usedJ = planRoute(grid, base, { stops: [grid.meta.waypoints[0]] }).legs[0].energyJ;
    const toHabitatJ = astar(grid, injuredCell, cellIndex(grid, grid.meta.habitat), rescueMove(base))!.energyJ;
    const toPickupJ = astar(grid, injuredCell, cellIndex(grid, pickup), rescueMove(base))!.energyJ;
    expect(toPickupJ).toBeLessThan(toHabitatJ);
    // A budget between the two: the pickup zone fits, the habitat does not.
    const params = applyParams(base, { EVA_ENERGY_BUDGET_J: usedJ + (toHabitatJ + toPickupJ) / 2 });

    const state = atFirstStop(grid, params, "buddy_injured");
    expect(state.recommendedAction).toBe("go_to_rover_pickup");
    expect(state.actionTargetId).toBe(pickup.id);
    expect(state.actionPath[state.actionPath.length - 1]).toEqual({ col: pickup.col, row: pickup.row });
    expect(state.warnings.some((line) => line.includes("habitat exceeds the EVA energy budget"))).toBe(true);
    expectNoImpassableCell(grid, state);
  });

  it("the rescuer first walks to a delayed injured buddy", () => {
    const grid = fixtureGrid();
    const state = atFirstStop(grid, defaultParams(), "buddy_injured", { delaysS: { B: 300 } });
    const [rescuer, injured] = state.astronauts;
    expect(state.actionPath[0]).toEqual(rescuer.cell);
    expect(state.actionPath).toContainEqual(injured.cell);
  });

  it("injured A makes B the rescuer, and the action is B's whatever `astronaut` is", () => {
    const grid = fixtureGrid();
    const state = atFirstStop(grid, defaultParams(), "buddy_injured", { injured: "A", delaysS: { B: 300 } });
    const [crewA, crewB] = state.astronauts;
    expect([crewA.status, crewB.status]).toEqual(["injured", "rescuer"]);
    expect(state.actionPath[0]).toEqual(crewB.cell);
    expect(state.actionPath).toContainEqual(crewA.cell);
  });

  it("actionDistanceM is the surface length of actionPath", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const state = atFirstStop(grid, params, "buddy_injured", { delaysS: { B: 300 } });
    const cells = state.actionPath.map((cell) => cellIndex(grid, cell));
    const lengthM = pathStats(grid, cells, walkingMove(params)).distanceM[cells.length - 1];
    expect(state.actionDistanceM).toBeGreaterThan(0);
    expect(state.actionDistanceM).toBeCloseTo(lengthM, 6);
  });

  it("bPosition moves B (also the separation) and keeps B's timeline energy", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const onTimeline = atFirstStop(grid, params, "none");
    const bPosition = { ...grid.meta.habitat };
    const dragged = atFirstStop(grid, params, "none", { bPosition });
    expect(dragged.astronauts[1].cell).toEqual(bPosition);
    expect(dragged.astronauts[1].usedJ).toBe(onTimeline.astronauts[1].usedJ);
    expect(dragged.separationM).toBeCloseTo(straightLineM(grid, cellIndex(grid, dragged.astronauts[0].cell), cellIndex(grid, bPosition)), 9);
    const rescue = atFirstStop(grid, params, "buddy_injured", { bPosition });
    expect(rescue.actionPath).toContainEqual(bPosition);
  });

  it("rejects a bad `injured` and a bPosition outside the grid or on an impassable cell", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const impassable = grid.terrainCost.findIndex((value) => value === grid.impassable);
    expect(impassable).toBeGreaterThanOrEqual(0);
    const wall = { col: impassable % grid.width, row: Math.floor(impassable / grid.width) };
    expect(() => atFirstStop(grid, params, "buddy_injured", { injured: "C" as "A" })).toThrow(/injured/);
    expect(() => atFirstStop(grid, params, "none", { bPosition: { col: -1, row: 0 } })).toThrow(/bPosition/);
    expect(() => atFirstStop(grid, params, "none", { bPosition: wall })).toThrow(/bPosition/);
  });

  it('warns "Rescue not feasible on foot within budget" when no target fits', () => {
    const grid = fixtureGrid();
    const base = defaultParams();
    // The budget is what the crew used to reach s1: any carry exceeds it.
    const usedJ = planRoute(grid, base, { stops: [grid.meta.waypoints[0]] }).legs[0].energyJ;
    const params = applyParams(base, { EVA_ENERGY_BUDGET_J: usedJ });
    const state = atFirstStop(grid, params, "buddy_injured");
    expect(state.recommendedAction).toBe("go_to_rover_pickup");
    expect(state.actionTargetId).not.toBeNull();
    expect(state.warnings).toContain("Rescue not feasible on foot within budget");
  });
});

describe("simulate: solar particle event", () => {
  it("chooses the shelter where the later crewmember arrives first", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    // B is still at the habitat (large delay), A is at s1 on the plateau.
    const state = atFirstStop(grid, params, "sep_event", { delaysS: { B: 1e6 } });
    const move = walkingMove(params);
    const [a, b] = state.astronauts.map((crew) => cellIndex(grid, crew.cell));
    const laterS = grid.meta.shelters.map((shelter) => {
      const target = cellIndex(grid, shelter);
      return { id: shelter.id, s: Math.max(astar(grid, a, target, move)!.timeS, astar(grid, b, target, move)!.timeS) };
    });
    laterS.sort((x, y) => x.s - y.s);
    expect(state.recommendedAction).toBe("go_to_shelter");
    expect(state.actionTargetId).toBe(laterS[0].id);
    expect(state.warnings).toContain("Charged particles can arrive in tens of minutes (SEP_ARRIVAL)");
    expectNoImpassableCell(grid, state);
  });

  it("lists every full shelter with both times, then the nearest terrain partial shelter, and recommends a full one", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const state = atFirstStop(grid, params, "sep_event", { delaysS: { B: 1e6 } });
    const move = walkingMove(params);
    const [a, b] = state.astronauts.map((crew) => cellIndex(grid, crew.cell));

    const full = state.shelters.filter((option) => option.kind === "full");
    expect(full.map((option) => option.shelterId)).toEqual(grid.meta.shelters.map((shelter) => shelter.id));
    for (const option of full) {
      expect(option.timeS.A).toBeCloseTo(astar(grid, a, cellIndex(grid, option.cell), move)!.timeS, 6);
      expect(option.timeS.B).toBeCloseTo(astar(grid, b, cellIndex(grid, option.cell), move)!.timeS, 6);
      expect(option.openSkyShare).toBeNull();
    }
    expect(full.some((option) => option.shelterId === state.actionTargetId)).toBe(true);

    const partial = state.shelters.filter((option) => option.kind === "partial");
    expect(partial).toHaveLength(1);
    const cell = cellIndex(grid, partial[0].cell);
    expect(partial[0].openSkyShare).toBeLessThanOrEqual(SHIELD_PARTIAL_MAX_SKY);
    expect(partial[0].openSkyShare).toBeCloseTo(grid.shield[cell] / 255, 9);
    // No sheltered cell is reached faster from A.
    const field = dijkstra(grid, a, move, false);
    for (let i = 0; i < grid.shield.length; i++) {
      if (grid.shield[i] / 255 <= SHIELD_PARTIAL_MAX_SKY) expect(field.timeS[i]).toBeGreaterThanOrEqual(field.timeS[cell]);
    }
    expect(partial[0].timeS.A).toBeCloseTo(astar(grid, a, cell, move)!.timeS, 6);
  });

  it("has no partial shelter when no cell is sheltered, and no shelter list outside sep_event", () => {
    const site = makeFixtureSite();
    site.files["shield.bin"] = new Uint8Array(site.meta.width * site.meta.height).fill(255).buffer as ArrayBuffer;
    const grid = parseSite(site.meta, site.files);
    const state = atFirstStop(grid, defaultParams(), "sep_event");
    expect(state.shelters.every((option) => option.kind === "full")).toBe(true);
    expect(atFirstStop(fixtureGrid(), defaultParams(), "none").shelters).toEqual([]);
  });

  it("warns only when the shelter is farther than SEP_SHELTER_TARGET_MIN", () => {
    const grid = fixtureGrid();
    const near = atFirstStop(grid, defaultParams(), "sep_event");
    expect(near.warnings.some((line) => line.includes("shelter target"))).toBe(false);
    const strict = applyParams(defaultParams(), { SEP_SHELTER_TARGET_MIN: 0 });
    const far = atFirstStop(grid, strict, "sep_event", { atTimeS: 600 });
    expect(far.warnings.some((line) => line.includes("shelter target"))).toBe(true);
  });
});

describe("planScience", () => {
  it("adds every stop when the budget allows, within the reserve limit", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const plan = planScience(grid, params);
    expect([...plan.stopIds].sort()).toEqual(["s1", "s2"]);
    expect(plan.totalValue).toBe(350);
    expect(plan.route.totalEnergyJ).toBeLessThanOrEqual(energyBudgetJ(params) * (1 - params.RESERVE_FRACTION));
  });

  it("with maxStops 1 it takes the best value per joule", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const ratio = (i: number) => {
      const point = grid.meta.waypoints[i];
      return point.scienceValue /planRoute(grid, params, { stops: [point] }).totalEnergyJ;
    };
    const expected = ratio(0) > ratio(1) ? "s1" : "s2";
    expect(planScience(grid, params, { maxStops: 1 }).stopIds).toEqual([expected]);
  });

  it("never goes over budgetJ * (1 - RESERVE_FRACTION)", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const bothJ = planScience(grid, params).route.totalEnergyJ;
    const budgetJ = (0.9 * bothJ) / (1 - params.RESERVE_FRACTION);
    const plan = planScience(grid, params, { budgetJ });
    expect(plan.stopIds.length).toBeLessThan(2);
    expect(plan.route.totalEnergyJ).toBeLessThanOrEqual(budgetJ * (1 - params.RESERVE_FRACTION));
    expect(planScience(grid, params, { budgetJ: 0 }).stopIds).toEqual([]);
  });
});

// The fixture plus single-cell science bumps. A: valid peak. B: 5 cells from A (too close). C: valid, lower.
// D: in the low-confidence east strip. E: on an impassable cell.
function fixtureWithPeaks(): { grid: Grid; cells: Record<string, number> } {
  const site = makeFixtureSite();
  const width = site.meta.width;
  const science = new Uint8Array(site.files["science_val.bin"].slice(0));
  const cost = new Uint8Array(site.files["terrain_cost.bin"]);
  const impassable = cost.findIndex((value) => value === 255);
  const cells = { A: 150 * width + 40, B: 152 * width + 45, C: 120 * width + 150, D: 150 * width + 197, E: impassable };
  const values = { A: 180, B: 170, C: 160, D: 250, E: 240 };
  for (const key of Object.keys(cells) as (keyof typeof cells)[]) science[cells[key]] = values[key];
  site.files["science_val.bin"] = science.buffer as ArrayBuffer;
  return { grid: parseSite(site.meta, site.files), cells };
}

describe("planScience with science peaks", () => {
  it("peaks are spaced local maxima on passable, normal-quality cells, best first", () => {
    const { grid, cells } = fixtureWithPeaks();
    const peaks = sciencePeaks(grid, defaultParams());
    expect(peaks.map((peak) => [peak.id, cellIndex(grid, peak)])).toEqual([
      ["p01", cells.A],
      ["p02", cells.C],
    ]);
    expect(peaks.length).toBeLessThanOrEqual(SCIENCE_PEAK_COUNT);
    const others = [grid.meta.habitat, ...grid.meta.waypoints, ...peaks].map((point) => cellIndex(grid, point));
    for (const peak of peaks) {
      expect(peak.kind).toBe("peak");
      const here = cellIndex(grid, peak);
      for (const other of others) {
        if (other !== here) expect(straightLineM(grid, here, other)).toBeGreaterThanOrEqual(SCIENCE_STOP_MIN_SPACING_M);
      }
    }
  });

  it("the plan considers the peaks and never exceeds the budget, at any budget", () => {
    const { grid } = fixtureWithPeaks();
    const params = defaultParams();
    const full = planScience(grid, params);
    expect(full.candidates.map((candidate) => candidate.id)).toEqual(["s1", "s2", "p01", "p02"]);
    expect(full.stopIds.some((id) => id.startsWith("p"))).toBe(true);
    const evaS = params.EVA_DURATION_H * SECONDS_PER_HOUR;
    for (const share of [0.2, 0.4, 0.6, 0.8, 1, 1.5]) {
      const budgetJ = (share * full.route.totalEnergyJ) / (1 - params.RESERVE_FRACTION);
      const plan = planScience(grid, params, { budgetJ });
      expect(plan.route.totalEnergyJ).toBeLessThanOrEqual(budgetJ * (1 - params.RESERVE_FRACTION));
      expect(plan.route.totalTimeS).toBeLessThanOrEqual(evaS);
      const values = new Map(plan.candidates.map((candidate) => [candidate.id, candidate.scienceValue]));
      expect(plan.totalValue).toBe(plan.stopIds.reduce((sum, id) => sum + (values.get(id) ?? 0), 0));
    }
  });
});

describe("determinism and worker", () => {
  it("same input gives identical simulate and planScience output", () => {
    const run = () => {
      const grid = fixtureGrid();
      const params = defaultParams();
      return [
        JSON.stringify(planScience(grid, params)),
        ...["none", "sep_event", "buddy_injured"].map((scenario) =>
          JSON.stringify(atFirstStop(grid, params, scenario, { delaysS: { B: 120 } })),
        ),
      ];
    };
    expect(run()).toEqual(run());
  });

  it("worker answers planScience and simulate, and errors on bad input", async () => {
    const state = createState();
    state.grid = fixtureGrid();
    const stops = [state.grid.meta.waypoints[0]];
    expect((await handleMessage(state, { type: "planScience", payload: {} })).type).toBe("sciencePlan");
    const sim = await handleMessage(state, { type: "simulate", payload: { scenario: "sep_event", atTimeS: 0, astronaut: "B", stops } });
    expect(sim.type).toBe("simState");

    const bad = [
      { type: "simulate", payload: { scenario: "storm", atTimeS: 0, astronaut: "A", stops } },
      { type: "simulate", payload: { scenario: "none", atTimeS: 0, astronaut: "C", stops } },
      { type: "simulate", payload: { scenario: "none", atTimeS: 0, astronaut: "A", stops, delaysS: { B: -1 } } },
      { type: "simulate", payload: { scenario: "none", atTimeS: 0, astronaut: "A", stops: [{ col: 40, row: 85 }] } },
      { type: "planScience", payload: { maxStops: -1 } },
    ];
    for (const message of bad) expect((await handleMessage(state, message)).type).toBe("error");
  });
});

// Reads the real pipeline output when it exists. Skipped otherwise (data is not in git).
const realSiteDir = fileURLToPath(new URL("../../app/public/sites/gale_boxwork/", import.meta.url));
const hasRealSite = existsSync(realSiteDir + "meta.json");

describe.skipIf(!hasRealSite)("real site (gale_boxwork pipeline output)", () => {
  it("plans science and runs every scenario", () => {
    const meta = JSON.parse(readFileSync(realSiteDir + "meta.json", "utf8")) as Meta;
    const files: Record<string, ArrayBuffer> = {};
    for (const layer of Object.values(meta.layers)) {
      const bytes = readFileSync(realSiteDir + layer.file);
      files[layer.file] = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }
    const grid = parseSite(meta, files);
    const params = defaultParams();

    const startMs = performance.now();
    const plan = planScience(grid, params);
    const planMs = performance.now() - startMs;
    console.log(
      `Real site planScience: ${planMs.toFixed(0)} ms, stops ${plan.stopIds.join(" ")}, value ${plan.totalValue}, ` +
        `${(plan.route.totalEnergyJ / 1e6).toFixed(2)} MJ, ${plan.route.verdict}`,
    );
    expect(plan.route.totalEnergyJ).toBeLessThanOrEqual(energyBudgetJ(params) * (1 - params.RESERVE_FRACTION));

    // Arrival at stop k: the walking legs up to it plus STOP_DWELL_MIN at each earlier stop.
    const arrivalS = (k: number) =>
      plan.route.legs.slice(0, k + 1).reduce((sum, leg) => sum + leg.timeS, 0) + k * params.STOP_DWELL_MIN * SECONDS_PER_MINUTE;
    const habitat = cellIndex(grid, grid.meta.habitat);
    const distanceM = plan.stops.map((stop) => straightLineM(grid, cellIndex(grid, stop), habitat));
    const farthest = distanceM.indexOf(Math.max(...distanceM));
    const atTimeS = arrivalS(farthest);
    console.log(
      `Real site: plan ${(plan.route.totalTimeS / SECONDS_PER_HOUR).toFixed(2)} h; event at ${plan.stopIds[farthest]}, ` +
        `${Math.round(distanceM[farthest])} m from the habitat, ${(atTimeS / SECONDS_PER_MINUTE).toFixed(0)} min into the EVA`,
    );
    const envelopeCells: Record<string, number> = {};
    for (const scenario of ["none", "sep_event", "buddy_injured"]) {
      const simStartMs = performance.now();
      const state = simulate(grid, params, { scenario, atTimeS, astronaut: "A", stops: plan.stops });
      const simMs = performance.now() - simStartMs;
      console.log(
        `Real site ${scenario}: ${simMs.toFixed(0)} ms, ${state.recommendedAction} -> ${state.actionTargetId}, ` +
          `${(state.actionTimeS / SECONDS_PER_MINUTE).toFixed(0)} min, ${(state.actionEnergyJ / 1e6).toFixed(2)} MJ, ` +
          `envelope ${maskCount(state.envelope.mask, 1)} cells (${maskCount(state.envelope.mask, 2)} safe); ${state.warnings.join("; ")}`,
      );
      for (const cell of state.actionPath) expect(grid.terrainCost[cellIndex(grid, cell)]).not.toBe(grid.impassable);
      envelopeCells[scenario] = maskCount(state.envelope.mask, 1);
    }
    // Contract version 6: the rescue safe area also ends where the carry path to the habitat passes RESCUE_DISTANCE_M.
    expect(envelopeCells.buddy_injured).toBeLessThan(envelopeCells.none);

    // Late in the EVA: injured at the end of the last stop.
    const last = plan.stops.length - 1;
    const lateS = arrivalS(last) + params.STOP_DWELL_MIN * SECONDS_PER_MINUTE;
    const lateWalk = simulate(grid, params, { scenario: "none", atTimeS: lateS, astronaut: "A", stops: plan.stops });
    const lateRescue = simulate(grid, params, { scenario: "buddy_injured", atTimeS: lateS, astronaut: "A", stops: plan.stops });
    console.log(
      `Real site late (${(lateS / SECONDS_PER_MINUTE).toFixed(0)} min, ${(lateWalk.astronauts[0].usedJ / 1e6).toFixed(2)} MJ used): ` +
        `walking ${maskCount(lateWalk.envelope.mask, 1)} (${maskCount(lateWalk.envelope.mask, 2)} safe), ` +
        `rescue ${maskCount(lateRescue.envelope.mask, 1)} (${maskCount(lateRescue.envelope.mask, 2)} safe)`,
    );
  }, 120_000);
});
