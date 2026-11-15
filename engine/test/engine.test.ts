import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { EVA_DURATION_H, MAX_SLOPE_DEG, RESCUE_SPEED_M_PER_S, SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from "../src/constants";
import {
  Params,
  Route,
  applyParams,
  astar,
  defaultParams,
  dijkstra,
  edgeEnergyJ,
  energyBudgetJ,
  pathStats,
  planRoute,
  shelterTimes,
  walkback,
  walkingMove,
} from "../src/engine";
import { Cell, Grid, Meta, cellIndex, loadSite, parseSite } from "../src/grid";
import { createState, handleMessage } from "../src/worker";
import { CELL_M, makeFixtureSite, makeTinySite } from "./fixtures";

const DEG = Math.PI / 180;

function fixtureGrid(options = {}): Grid {
  const site = makeFixtureSite(options);
  return parseSite(site.meta, site.files);
}

// Energy of the one edge 0 -> 1 on a 2 x 1 grid whose second cell is higher by tan(theta) * cell size.
function singleEdgeEnergy(thetaDeg: number): number {
  const rise = CELL_M * Math.tan(thetaDeg * DEG);
  const site = makeTinySite(2, 1, [0, rise]);
  const grid = parseSite(site.meta, site.files);
  return edgeEnergyJ(grid, 0, 1, walkingMove(defaultParams()));
}

function routeCellIndices(grid: Grid, route: Route): number[] {
  return route.path.map((cell) => cellIndex(grid, cell));
}

// Every cell passable and every edge at or below MAX_SLOPE_DEG.
function expectRouteWalkable(grid: Grid, route: Route): void {
  const cells = routeCellIndices(grid, route);
  for (const cell of cells) expect(grid.terrainCost[cell]).not.toBe(grid.impassable);
  const stats = pathStats(grid, cells, walkingMove(defaultParams()));
  expect(stats.maxEdgeSlopeDeg).toBeLessThanOrEqual(MAX_SLOPE_DEG);
}

// The band covers the west 70% of the columns around row 0.425 N. A route may cross those rows only further east.
function expectAvoidsCliffBand(grid: Grid, route: Route): void {
  const size = grid.width;
  const bandRows = route.path.filter((cell) => Math.abs(cell.row - Math.round(0.425 * size)) <= 4);
  expect(bandRows.length).toBeGreaterThan(0);
  for (const cell of bandRows) expect(cell.col).toBeGreaterThan(0.7 * size);
}

function sameCell(a: Cell, b: Cell): boolean {
  return a.col === b.col && a.row === b.row;
}

function maskCount(mask: Uint8Array, minLevel: number): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] >= minLevel) count += 1;
  return count;
}

const SOUTH_WEST: Cell = { col: 40, row: 150 }; // south plain, below the band

describe("edge cost (Santee, directional)", () => {
  it("1. uphill > flat > moderate downhill (-5 deg)", () => {
    const uphill = singleEdgeEnergy(5);
    const flat = singleEdgeEnergy(0);
    const downhill = singleEdgeEnergy(-5);
    expect(uphill).toBeGreaterThan(flat);
    expect(flat).toBeGreaterThan(downhill);
  });

  it("2. cost(u->v) != cost(v->u) on a slope", () => {
    const rise = CELL_M * Math.tan(10 * DEG);
    const site = makeTinySite(2, 1, [0, rise]);
    const grid = parseSite(site.meta, site.files);
    const move = walkingMove(defaultParams());
    expect(edgeEnergyJ(grid, 0, 1, move)).not.toBeCloseTo(edgeEnergyJ(grid, 1, 0, move), 3);
  });

  it("edge steeper than MAX_SLOPE_DEG and impassable cells are Infinity", () => {
    expect(singleEdgeEnergy(MAX_SLOPE_DEG + 1)).toBe(Infinity);
    const site = makeTinySite(2, 1, [0, 0], [10, 255]);
    const grid = parseSite(site.meta, site.files);
    expect(edgeEnergyJ(grid, 0, 1, walkingMove(defaultParams()))).toBe(Infinity);
  });

  it("no corner cutting between two impassable cells", () => {
    // 2 x 2: NE and SW impassable. The diagonal (0,0) -> (1,1) would slip between them.
    const site = makeTinySite(2, 2, [0, 0, 0, 0], [10, 255, 255, 10]);
    const grid = parseSite(site.meta, site.files);
    expect(edgeEnergyJ(grid, 0, 3, walkingMove(defaultParams()))).toBe(Infinity);
  });

  it("rescue mode (heavier load, slower speed) costs at least the normal walk on the same path", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const route = planRoute(grid, params, { stops: [grid.meta.waypoints[0]] });
    const cells = routeCellIndices(grid, route);
    const normal = walkingMove(params);
    const rescue = { ...normal, massKg: 2 * normal.massKg, speedMPerS: RESCUE_SPEED_M_PER_S };
    const normalJ = pathStats(grid, cells, normal).energyJ[cells.length - 1];
    const rescueJ = pathStats(grid, cells, rescue).energyJ[cells.length - 1];
    expect(rescueJ).toBeGreaterThanOrEqual(normalJ);
  });
});

describe("routing", () => {
  it("3. no route includes an impassable cell or crosses the cliff band", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const rover = grid.meta.shelters[1];
    const routes = [
      planRoute(grid, params, { stops: [grid.meta.waypoints[0]] }),
      planRoute(grid, params, { stops: [grid.meta.waypoints[1]] }),
      planRoute(grid, params, { stops: grid.meta.waypoints }),
      planRoute(grid, params, { end: rover, stops: [] }),
    ];
    for (const route of routes) {
      expect(route.verdict).not.toBe("NO_GO");
      expectRouteWalkable(grid, route);
      expectAvoidsCliffBand(grid, route);
    }
  });

  it("5. detour around the cliff costs at least the best route with the cliff allowed", () => {
    const rover = { col: 40, row: 60 };
    const constrainedGrid = fixtureGrid();
    const constrained = planRoute(constrainedGrid, defaultParams(), { start: SOUTH_WEST, end: rover, stops: [] });

    const openGrid = fixtureGrid({ steepPassable: true });
    const openParams = applyParams(defaultParams(), { MAX_SLOPE_DEG: 90 });
    const open = planRoute(openGrid, openParams, { start: SOUTH_WEST, end: rover, stops: [] });

    expect(constrained.totalEnergyJ).toBeGreaterThanOrEqual(open.totalEnergyJ);
    // The detour really happened: the constrained route is longer and the open one climbs the band directly.
    expect(constrained.legs[0].distanceM).toBeGreaterThan(open.legs[0].distanceM);
    expect(open.path.some((cell) => cell.col < 0.7 * openGrid.width && Math.abs(cell.row - 85) <= 4)).toBe(true);
  });

  it("6. non-habitat start to non-habitat end avoids the cliff band", () => {
    const grid = fixtureGrid();
    const rover = grid.meta.shelters[1];
    const route = planRoute(grid, defaultParams(), { start: SOUTH_WEST, end: rover, stops: [] });
    expect(route.verdict).not.toBe("NO_GO");
    expect(sameCell(route.path[0], SOUTH_WEST)).toBe(true);
    expect(sameCell(route.path[route.path.length - 1], rover)).toBe(true);
    expect(route.legs[0].from).toBe("40,150");
    expect(route.legs[0].to).toBe("rover");
    expectRouteWalkable(grid, route);
    expectAvoidsCliffBand(grid, route);
  });

  it("8. default planRoute begins and ends at the habitat", () => {
    const grid = fixtureGrid();
    const habitat = grid.meta.habitat;
    const route = planRoute(grid, defaultParams(), { stops: [grid.meta.waypoints[0]] });
    expect(sameCell(route.path[0], habitat)).toBe(true);
    expect(sameCell(route.path[route.path.length - 1], habitat)).toBe(true);
    expect(route.legs.map((leg) => [leg.from, leg.to])).toEqual([
      ["habitat", "s1"],
      ["s1", "habitat"],
    ]);
  });

  it("route totals, profile and verdict are consistent", () => {
    const grid = fixtureGrid();
    const route = planRoute(grid, defaultParams(), { stops: grid.meta.waypoints });
    const legEnergy = route.legs.reduce((sum, leg) => sum + leg.energyJ, 0);
    const legTime = route.legs.reduce((sum, leg) => sum + leg.timeS, 0);
    // Totals = walking legs + STOP_DWELL_MIN at each stop, at STATION_WORK_W (contract version 8).
    const params = defaultParams();
    const stopTimeS = grid.meta.waypoints.length * params.STOP_DWELL_MIN * SECONDS_PER_MINUTE;
    expect(route.stopTimeS).toBe(stopTimeS);
    expect(route.stopEnergyJ).toBeCloseTo(stopTimeS * params.STATION_WORK_W, 6);
    expect(route.totalEnergyJ).toBeCloseTo(legEnergy + route.stopEnergyJ, 3);
    expect(route.totalTimeS).toBeCloseTo(legTime + stopTimeS, 6);
    expect(route.elevationProfile.length).toBe(route.path.length);
    expect(route.elevationProfile[0].distanceM).toBe(0);
    // The hill flanks reach about 15 deg, so CAUTION is possible. The route is short, so never NO_GO.
    expect(["GO", "CAUTION"]).toContain(route.verdict);
  });

  it("stop on an impassable cell gives NO_GO with a reason", () => {
    const grid = fixtureGrid();
    const cliffCell = { col: 40, row: 85 };
    const route = planRoute(grid, defaultParams(), { stops: [cliffCell] });
    expect(route.verdict).toBe("NO_GO");
    expect(route.reasons[0]).toContain("impassable");
  });

  it("route above the energy budget is NO_GO", () => {
    const grid = fixtureGrid();
    const params = applyParams(defaultParams(), { EVA_ENERGY_BUDGET_J: 1000 });
    const route = planRoute(grid, params, { stops: [grid.meta.waypoints[0]] });
    expect(route.verdict).toBe("NO_GO");
    expect(route.reasons.some((line) => line.includes("energy budget"))).toBe(true);
  });
});

describe("walk-back envelope", () => {
  it("4. envelope area shrinks as usedJ increases", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const budget = energyBudgetJ(params);
    const usedValues = [0, budget - 400e3, budget - 200e3, budget - 50e3];
    const reachable = usedValues.map((usedJ) => maskCount(walkback(grid, params, { elapsedS: 0, usedJ }).mask, 1));
    const safe = usedValues.map((usedJ) => maskCount(walkback(grid, params, { elapsedS: 0, usedJ }).mask, 2));
    for (let i = 1; i < usedValues.length; i++) {
      expect(reachable[i]).toBeLessThan(reachable[i - 1]);
      expect(safe[i]).toBeLessThanOrEqual(safe[i - 1]);
    }
  });

  it("envelope shrinks as elapsed EVA time increases", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const evaS = EVA_DURATION_H * SECONDS_PER_HOUR;
    const elapsedValues = [0, evaS - 600, evaS - 300, evaS - 60];
    const reachable = elapsedValues.map((elapsedS) => maskCount(walkback(grid, params, { elapsedS, usedJ: 0 }).mask, 1));
    for (let i = 1; i < elapsedValues.length; i++) expect(reachable[i]).toBeLessThan(reachable[i - 1]);
  });

  it("7. envelope changes when returnPoint changes (habitat vs rover pickup zone)", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const usedJ = energyBudgetJ(params) - 200e3;
    const toHabitat = walkback(grid, params, { elapsedS: 0, usedJ }).mask;
    const pickup = grid.meta.roverPickupZones[0];
    const toPickup = walkback(grid, params, { elapsedS: 0, usedJ, returnPoint: pickup }).mask;
    let differing = 0;
    for (let i = 0; i < toHabitat.length; i++) if (toHabitat[i] !== toPickup[i]) differing += 1;
    expect(differing).toBeGreaterThan(0);
    expect(toPickup[cellIndex(grid, pickup)]).toBeGreaterThan(0);
  });

  it("dijkstra distanceM is the ground length of the path", () => {
    const site = makeTinySite(3, 1, [0, 0, 0]);
    const grid = parseSite(site.meta, site.files);
    const field = dijkstra(grid, 0, walkingMove(defaultParams()), true);
    expect(Array.from(field.distanceM)).toEqual([0, CELL_M, 2 * CELL_M]);
  });

  it("a return path longer than move.maxPathM is 0 in the mask (rescue carry limit)", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const limitM = 300; // test value: the fixture is smaller than RESCUE_DISTANCE_M, so the real limit never bites here
    const limited = { ...walkingMove(params), maxPathM: limitM };
    const field = dijkstra(grid, cellIndex(grid, grid.meta.habitat), limited, true);
    const mask = walkback(grid, params, { elapsedS: 0, usedJ: 0 }, limited).mask;
    for (let i = 0; i < mask.length; i++) if (mask[i] > 0) expect(field.distanceM[i]).toBeLessThanOrEqual(limitM);
    expect(maskCount(mask, 1)).toBeGreaterThan(0);
    expect(maskCount(mask, 1)).toBeLessThan(maskCount(walkback(grid, params, { elapsedS: 0, usedJ: 0 }).mask, 1));
  });

  it("impassable cells are never in the envelope", () => {
    const grid = fixtureGrid();
    const mask = walkback(grid, defaultParams(), { elapsedS: 0, usedJ: 0 }).mask;
    for (let i = 0; i < mask.length; i++) {
      if (grid.terrainCost[i] === grid.impassable) expect(mask[i]).toBe(0);
    }
  });

  it("turnBackAtS and remainingJ follow the documented formula", () => {
    const grid = fixtureGrid();
    const params = defaultParams();
    const usedJ = 1e6;
    const elapsedS = 3600;
    const position = grid.meta.waypoints[0];
    const envelope = walkback(grid, params, { elapsedS, usedJ, position });
    const field = dijkstra(grid, cellIndex(grid, grid.meta.habitat), walkingMove(params), true);
    const p = cellIndex(grid, position);
    const budget = energyBudgetJ(params);
    const energySlackJ = budget * (1 - params.RESERVE_FRACTION) - usedJ - field.energyJ[p];
    const timeSlackS = params.EVA_DURATION_H * SECONDS_PER_HOUR - elapsedS - field.timeS[p];
    const expected = elapsedS + Math.max(0, Math.min(timeSlackS, energySlackJ / params.STATION_WORK_W));
    expect(envelope.turnBackAtS).toBeCloseTo(expected, 6);
    expect(envelope.remainingJ).toBe(budget - usedJ);
  });
});

describe("shelter times", () => {
  it("lists the meta.json shelters, fastest first, with walkable paths", () => {
    const grid = fixtureGrid();
    const result = shelterTimes(grid, defaultParams(), grid.meta.waypoints[0]);
    expect(result.options.map((option) => option.shelterId).sort()).toEqual(["habitat", "rover"]);
    expect(result.options[0].timeS).toBeLessThanOrEqual(result.options[1].timeS);
    // s1 is on the plateau, near the rover. The habitat is below the band.
    expect(result.options[0].shelterId).toBe("rover");
  });

  it("an impassable start cell is never on a route (no walking off it, no shelter path from it)", () => {
    // 2 x 1, flat: cell 0 impassable, cell 1 passable. Only the start cell blocks the edge.
    const site = makeTinySite(2, 1, [0, 0], [255, 10]);
    const tiny = parseSite(site.meta, site.files);
    const move = walkingMove(defaultParams());
    expect(edgeEnergyJ(tiny, 0, 1, move)).toBe(Infinity);
    expect(astar(tiny, 0, 1, move)).toBeNull();
    expect(astar(tiny, 0, 0, move)).toBeNull();

    const grid = fixtureGrid();
    const cliffCell = { col: 40, row: 85 };
    expect(grid.terrainCost[cellIndex(grid, cliffCell)]).toBe(grid.impassable);
    expect(() => shelterTimes(grid, defaultParams(), cliffCell)).toThrow(/impassable/);
  });
});

describe("determinism", () => {
  it("9. same input gives identical output", () => {
    const run = () => {
      const grid = fixtureGrid();
      const params = defaultParams();
      return {
        route: JSON.stringify(planRoute(grid, params, { stops: grid.meta.waypoints })),
        mask: Array.from(walkback(grid, params, { elapsedS: 1800, usedJ: 7e6 }).mask),
        shelters: JSON.stringify(shelterTimes(grid, params, SOUTH_WEST)),
      };
    };
    const first = run();
    const second = run();
    expect(second.route).toBe(first.route);
    expect(second.shelters).toBe(first.shelters);
    expect(second.mask).toEqual(first.mask);
  });
});

describe("performance", () => {
  it(
    "10. Dijkstra one-to-all on a 1000 x 1000 grid in under 3 s",
    () => {
      const grid = fixtureGrid({ size: 1000 });
      const source = cellIndex(grid, grid.meta.habitat);
      const move = walkingMove(defaultParams());
      const startMs = performance.now();
      const field = dijkstra(grid, source, move, true);
      const elapsedMs = performance.now() - startMs;
      console.log(`Dijkstra 1000 x 1000 (reversed edges): ${elapsedMs.toFixed(0)} ms`);
      expect(field.energyJ[source]).toBe(0);
      expect(elapsedMs).toBeLessThan(3000);
    },
    60_000,
  );
});

describe("grid loading and worker", () => {
  it("parseSite rejects a wrong layer length and an unsupported version", () => {
    const site = makeTinySite(2, 1, [0, 0]);
    const badFiles = { ...site.files, "shield.bin": new ArrayBuffer(3) };
    expect(() => parseSite(site.meta, badFiles)).toThrow(/shield.bin/);
    expect(() => parseSite({ ...site.meta, version: 2 }, site.files)).toThrow(/version/);
  });

  it("loadSite reads meta.json and every layer through fetch", async () => {
    const site = makeFixtureSite({ size: 50 });
    const fakeFetch = async (url: string) => {
      const name = url.split("/").pop() as string;
      const isMeta = name === "meta.json";
      const found = isMeta || name in site.files;
      return {
        ok: found,
        status: found ? 200 : 404,
        json: async () => JSON.parse(JSON.stringify(site.meta)),
        arrayBuffer: async () => site.files[name].slice(0),
      };
    };
    const grid = await loadSite("sites/fixture", fakeFetch);
    expect(grid.width).toBe(50);
    expect(grid.elevation.length).toBe(2500);
  });

  it("worker replies with contract types and errors", async () => {
    const state = createState();
    expect((await handleMessage(state, { type: "planRoute", payload: { stops: [] } })).type).toBe("error");

    state.grid = fixtureGrid();
    const route = await handleMessage(state, { type: "planRoute", payload: { stops: [state.grid.meta.waypoints[0]] } });
    expect(route.type).toBe("route");

    const envelope = await handleMessage(state, { type: "walkback", payload: { elapsedS: 0, usedJ: 0 } });
    expect(envelope.type).toBe("envelope");

    expect(await handleMessage(state, { type: "setParams", payload: { params: { RESERVE_FRACTION: 0.3 } } })).toEqual({ type: "paramsSet" });
    expect(state.params.RESERVE_FRACTION).toBe(0.3);

    // Marked "Adjustable" in docs/assumptions.md.
    const adjustable = { RESCUE_SPEED_M_PER_S: 0.4, BUDDY_MAX_SEPARATION_M: 80 };
    expect(await handleMessage(state, { type: "setParams", payload: { params: adjustable } })).toEqual({ type: "paramsSet" });
    expect(state.params.RESCUE_SPEED_M_PER_S).toBe(0.4);
    expect(state.params.BUDDY_MAX_SEPARATION_M).toBe(80);

    const badParam = await handleMessage(state, { type: "setParams", payload: { params: { NOT_A_CONSTANT: 1 } } });
    expect(badParam).toEqual({ type: "error", request: "setParams", message: "unknown parameter NOT_A_CONSTANT" });

    const later = await handleMessage(state, { type: "simulate", payload: {} });
    expect(later.type).toBe("error");
  });
});

// Reads the real pipeline output when it exists. Skipped otherwise (data is not in git).
const realSiteDir = fileURLToPath(new URL("../../app/public/sites/gale_boxwork/", import.meta.url));
const hasRealSite = existsSync(realSiteDir + "meta.json");

describe.skipIf(!hasRealSite)("real site (gale_boxwork pipeline output)", () => {
  it("loads, routes through the Curiosity stops and builds an envelope", () => {
    const meta = JSON.parse(readFileSync(realSiteDir + "meta.json", "utf8")) as Meta;
    const files: Record<string, ArrayBuffer> = {};
    for (const layer of Object.values(meta.layers)) {
      const bytes = readFileSync(realSiteDir + layer.file);
      files[layer.file] = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    }
    const grid = parseSite(meta, files);
    const params: Params = defaultParams();

    const startMs = performance.now();
    const envelope = walkback(grid, params, { elapsedS: 0, usedJ: 0 });
    const walkbackMs = performance.now() - startMs;

    const routeStartMs = performance.now();
    const route = planRoute(grid, params, { stops: grid.meta.waypoints });
    const routeMs = performance.now() - routeStartMs;

    console.log(
      `Real site ${grid.width} x ${grid.height}: walk-back ${walkbackMs.toFixed(0)} ms, ` +
        `route through ${grid.meta.waypoints.length} stops ${routeMs.toFixed(0)} ms, ` +
        `${(route.totalEnergyJ / 1e6).toFixed(2)} MJ, ${(route.totalTimeS / 3600).toFixed(2)} h, ${route.verdict}: ${route.reasons.join("; ")}`,
    );
    expect(maskCount(envelope.mask, 1)).toBeGreaterThan(0);
    expect(route.path.length).toBeGreaterThan(0);
    if (route.verdict !== "NO_GO") expectRouteWalkable(grid, route);

    // docs/assumptions.md: pickup zones and stops must be reachable on foot from the habitat.
    // The pipeline picks them; this checks it used the same edge rules as the engine.
    const fromHabitat = dijkstra(grid, cellIndex(grid, grid.meta.habitat), walkingMove(params), false);
    const points = [...grid.meta.shelters, ...grid.meta.roverPickupZones, ...grid.meta.waypoints];
    const unreachable = points.filter((point) => fromHabitat.energyJ[cellIndex(grid, point)] === Infinity).map((point) => point.id);
    expect(unreachable).toEqual([]);
  }, 60_000);
});
