// Synthetic test sites written in the exact docs/data-contract.md format (meta.json + raw .bin bytes).
// These are fixtures for tests only. They are not Mars data and must never be shown as real terrain.

import { CAUTION_SLOPE_DEG, CAUTION_SLOPE_PENALTY, MAX_SLOPE_DEG } from "../src/constants";
import { CONTRACT_VERSION, Meta } from "../src/grid";

export type SiteFiles = { meta: Meta; files: Record<string, ArrayBuffer> };

const CELL_M = 3.0;
const NO_DATA = -9999;
const BASE_ELEVATION_M = -4000;
const COST_SCALE = 0.1;
const COST_IMPASSABLE = 255;
const COST_NORMAL = 10; // multiplier 1.0
const DEG = Math.PI / 180;

// Fixture shape. A 25 deg band over CLIFF_CELLS rows separates the south plain from the north plateau.
// In the east the same rise is spread over a 5 deg ramp, so routes can go around the band.
const CLIFF_SLOPE_DEG = 25;
const CLIFF_CELLS = 10;
const RAMP_SLOPE_DEG = 5;
const STEP_HEIGHT_M = CLIFF_CELLS * CELL_M * Math.tan(CLIFF_SLOPE_DEG * DEG);
const RAMP_CELLS = STEP_HEIGHT_M / (CELL_M * Math.tan(RAMP_SLOPE_DEG * DEG));
const HILL_HEIGHT_M = 20;

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

function float32Bytes(values: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  for (let i = 0; i < values.length; i++) view.setFloat32(i * 4, values[i], true);
  return buffer;
}

// Same rule as the pipeline (docs/data-contract.md, section 1): cell slope from central differences,
// 255 above MAX_SLOPE_DEG, CAUTION_SLOPE_PENALTY in the caution band.
function terrainCostFromSlope(elevation: Float32Array, width: number, height: number, steepPassable: boolean): Uint8Array {
  const cost = new Uint8Array(width * height);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const west = elevation[row * width + Math.max(0, col - 1)];
      const east = elevation[row * width + Math.min(width - 1, col + 1)];
      const north = elevation[Math.max(0, row - 1) * width + col];
      const south = elevation[Math.min(height - 1, row + 1) * width + col];
      const colSpan = (Math.min(width - 1, col + 1) - Math.max(0, col - 1)) * CELL_M;
      const rowSpan = (Math.min(height - 1, row + 1) - Math.max(0, row - 1)) * CELL_M;
      const gx = colSpan > 0 ? (east - west) / colSpan : 0;
      const gy = rowSpan > 0 ? (south - north) / rowSpan : 0;
      const slopeDeg = Math.atan(Math.hypot(gx, gy)) / DEG;

      let value = COST_NORMAL;
      if (slopeDeg > CAUTION_SLOPE_DEG) value = Math.round(COST_NORMAL * CAUTION_SLOPE_PENALTY);
      if (slopeDeg > MAX_SLOPE_DEG) value = steepPassable ? COST_NORMAL : COST_IMPASSABLE;
      cost[row * width + col] = value;
    }
  }
  return cost;
}

function buildMeta(width: number, height: number, points: Pick<Meta, "habitat" | "shelters" | "roverPickupZones" | "waypoints">): Meta {
  const meta = {
    version: CONTRACT_VERSION,
    site: "fixture",
    name: "Synthetic test grid (not Mars data)",
    width,
    height,
    cellSizeMeters: CELL_M,
    crs: "+proj=eqc +lat_ts=0 +lon_0=0 +R=3396190 +units=m +no_defs",
    transform: [CELL_M, 0, 0, 0, -CELL_M, 0],
    bounds: { west: 0, south: -height * CELL_M, east: width * CELL_M, north: 0 },
    byteOrder: "little",
    rowOrder: "north_to_south",
    noData: NO_DATA,
    layers: {
      elevation: { file: "elevation.bin", type: "float32", units: "m (areoid)" },
      terrainCost: { file: "terrain_cost.bin", type: "uint8", scale: COST_SCALE, impassable: COST_IMPASSABLE },
      shield: { file: "shield.bin", type: "uint8" },
      scienceValue: { file: "science_val.bin", type: "uint8" },
      demQuality: { file: "dem_quality.bin", type: "uint8", values: { "0": "normal", "1": "low_confidence" } },
    },
    overlays: [],
    sources: [],
    notes: [{ id: "fixture", text: "Synthetic test grid. Not Mars data." }],
    constants: {},
    ...points,
  };
  return meta as Meta;
}

function packFiles(meta: Meta, elevation: Float32Array, cost: Uint8Array, shield: Uint8Array, science: Uint8Array, quality: Uint8Array): SiteFiles {
  return {
    meta,
    files: {
      "elevation.bin": float32Bytes(elevation),
      "terrain_cost.bin": cost.buffer as ArrayBuffer,
      "shield.bin": shield.buffer as ArrayBuffer,
      "science_val.bin": science.buffer as ArrayBuffer,
      "dem_quality.bin": quality.buffer as ArrayBuffer,
    },
  };
}

export type FixtureOptions = { size?: number; steepPassable?: boolean };

// Layout (size N, cells of 3 m), row 0 is north:
// - north plateau with a Gaussian hill, the rover (shelter + pickup zone rp1) and two waypoints
// - 25 deg band (impassable) centered at row 0.425 N over the west 70% of the columns
// - 5 deg ramp in the east 20%, a smooth blend between 0.7 N and 0.8 N
// - south plain with the habitat
// - the east 5 columns are flagged low-confidence DEM
// steepPassable = true writes normal terrain cost on the steep cells (for the "cliff allowed" comparison).
export function makeFixtureSite(options: FixtureOptions = {}): SiteFiles {
  const size = options.size ?? 200;
  const width = size;
  const height = size;
  const count = width * height;

  const bandCenterRow = Math.round(0.425 * size);
  const blendStartCol = 0.7 * size;
  const blendEndCol = 0.8 * size;
  const hillCol = 0.3 * size;
  const hillRow = 0.175 * size;
  const hillSigmaCells = 0.075 * size;

  const elevation = new Float32Array(count);
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const blend = smoothstep((col - blendStartCol) / (blendEndCol - blendStartCol));
      const transitionCells = CLIFF_CELLS + (RAMP_CELLS - CLIFF_CELLS) * blend;
      const stepShare = Math.min(1, Math.max(0, (bandCenterRow + transitionCells / 2 - row) / transitionCells));
      const hillDistSq = (col - hillCol) ** 2 + (row - hillRow) ** 2;
      const hillM = HILL_HEIGHT_M * Math.exp(-hillDistSq / (2 * hillSigmaCells ** 2));
      elevation[row * width + col] = BASE_ELEVATION_M + STEP_HEIGHT_M * stepShare + hillM;
    }
  }

  const cost = terrainCostFromSlope(elevation, width, height, options.steepPassable ?? false);
  const shield = new Uint8Array(count).fill(255);
  const quality = new Uint8Array(count);
  for (let row = 0; row < height; row++) {
    for (let col = width - 5; col < width; col++) quality[row * width + col] = 1;
  }

  const at = (colShare: number, rowShare: number) => ({ col: Math.round(colShare * size), row: Math.round(rowShare * size) });
  const habitat = at(0.5, 0.85);
  const rover = at(0.2, 0.3);
  const waypoints = [
    { id: "s1", ...at(0.3, 0.175), name: "Fixture hill top", scienceValue: 200 },
    { id: "s2", ...at(0.85, 0.2), name: "Fixture plateau east", scienceValue: 150 },
  ];
  const science = new Uint8Array(count);
  for (const point of waypoints) science[point.row * width + point.col] = point.scienceValue;

  const meta = buildMeta(width, height, {
    habitat,
    shelters: [
      { id: "habitat", ...habitat, kind: "full" },
      { id: "rover", ...rover, kind: "full" },
    ],
    roverPickupZones: [{ id: "rp1", ...rover, areaM2: 5400 }],
    waypoints,
  });
  return packFiles(meta, elevation, cost, shield, science, quality);
}

// A small grid from given elevations (row-major), all cells normal cost unless given. Habitat at (0, 0).
export function makeTinySite(width: number, height: number, elevations: number[], costBytes?: number[]): SiteFiles {
  const count = width * height;
  const elevation = Float32Array.from(elevations);
  const cost = costBytes ? Uint8Array.from(costBytes) : new Uint8Array(count).fill(COST_NORMAL);
  const habitat = { col: 0, row: 0 };
  const meta = buildMeta(width, height, {
    habitat,
    shelters: [{ id: "habitat", ...habitat, kind: "full" }],
    roverPickupZones: [],
    waypoints: [],
  });
  return packFiles(meta, elevation, cost, new Uint8Array(count), new Uint8Array(count), new Uint8Array(count));
}

export { CELL_M, COST_NORMAL };
