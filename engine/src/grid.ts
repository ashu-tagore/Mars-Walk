// Load the pipeline output (docs/data-contract.md, sections 1 and 2) into typed arrays.

// docs/data-contract.md "version". The engine reads only this meta.json version.
export const CONTRACT_VERSION = 8;

export type Cell = { col: number; row: number };

export type LayerInfo = { file: string; type: string; scale?: number; impassable?: number };

export type SitePoint = { id: string; col: number; row: number };

export type Meta = {
  version: number;
  site: string;
  width: number;
  height: number;
  cellSizeMeters: number;
  byteOrder: string;
  rowOrder: string;
  noData: number;
  layers: {
    elevation: LayerInfo;
    terrainCost: LayerInfo;
    shield: LayerInfo;
    scienceValue: LayerInfo;
    demQuality: LayerInfo;
  };
  habitat: Cell;
  shelters: (SitePoint & { kind: "full" | "partial" })[];
  roverPickupZones: (SitePoint & { areaM2: number })[];
  waypoints: (SitePoint & { name?: string; scienceValue?: number })[];
};

export type Grid = {
  meta: Meta;
  width: number;
  height: number;
  cellSizeM: number;
  noData: number;
  elevation: Float32Array;
  terrainCost: Uint8Array;
  terrainScale: number;
  impassable: number;
  shield: Uint8Array;
  scienceValue: Uint8Array;
  demQuality: Uint8Array;
  // Smallest passable terrain multiplier in the grid. A* needs it for a heuristic that never overestimates.
  minTerrainMultiplier: number;
};

export function cellIndex(grid: Grid, cell: Cell): number {
  return cell.row * grid.width + cell.col;
}

export function cellAt(grid: Grid, index: number): Cell {
  const col = index % grid.width;
  return { col, row: (index - col) / grid.width };
}

export function isInside(grid: Grid, cell: Cell): boolean {
  const colOk = Number.isInteger(cell.col) && cell.col >= 0 && cell.col < grid.width;
  const rowOk = Number.isInteger(cell.row) && cell.row >= 0 && cell.row < grid.height;
  return colOk && rowOk;
}

// The contract fixes little-endian. DataView reads it the same way on every platform.
function readFloat32(buffer: ArrayBuffer, count: number, name: string): Float32Array {
  checkLength(buffer, count * 4, name);
  const view = new DataView(buffer);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function readUint8(buffer: ArrayBuffer, count: number, name: string): Uint8Array {
  checkLength(buffer, count, name);
  return new Uint8Array(buffer.slice(0));
}

function checkLength(buffer: ArrayBuffer | undefined, bytes: number, name: string): void {
  if (!buffer) throw new Error(`missing layer file ${name}`);
  if (buffer.byteLength !== bytes) {
    throw new Error(`${name} has ${buffer.byteLength} bytes, expected ${bytes} (width * height elements)`);
  }
}

// files: layer file name (as in meta.layers[*].file) -> raw bytes.
export function parseSite(meta: Meta, files: Record<string, ArrayBuffer>): Grid {
  if (meta.version !== CONTRACT_VERSION) {
    throw new Error(`meta.json version ${meta.version} is not supported (engine reads version ${CONTRACT_VERSION})`);
  }
  if (meta.byteOrder !== "little" || meta.rowOrder !== "north_to_south") {
    throw new Error("meta.json byteOrder must be little and rowOrder north_to_south");
  }

  const count = meta.width * meta.height;
  const layers = meta.layers;
  const terrainCost = readUint8(files[layers.terrainCost.file], count, layers.terrainCost.file);
  const terrainScale = layers.terrainCost.scale;
  const impassable = layers.terrainCost.impassable;
  if (terrainScale === undefined || impassable === undefined) {
    throw new Error("meta.json layers.terrainCost must give scale and impassable");
  }

  let minCostByte = impassable;
  for (let i = 0; i < count; i++) {
    const value = terrainCost[i];
    if (value !== impassable && value < minCostByte) minCostByte = value;
  }

  return {
    meta,
    width: meta.width,
    height: meta.height,
    cellSizeM: meta.cellSizeMeters,
    noData: meta.noData,
    elevation: readFloat32(files[layers.elevation.file], count, layers.elevation.file),
    terrainCost,
    terrainScale,
    impassable,
    shield: readUint8(files[layers.shield.file], count, layers.shield.file),
    scienceValue: readUint8(files[layers.scienceValue.file], count, layers.scienceValue.file),
    demQuality: readUint8(files[layers.demQuality.file], count, layers.demQuality.file),
    minTerrainMultiplier: minCostByte * terrainScale,
  };
}

type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

export async function loadSite(siteUrl: string, fetchFn: FetchFn = fetch): Promise<Grid> {
  const base = siteUrl.endsWith("/") ? siteUrl : siteUrl + "/";

  const metaResponse = await fetchFn(base + "meta.json");
  if (!metaResponse.ok) throw new Error(`meta.json: HTTP ${metaResponse.status}`);
  const meta = (await metaResponse.json()) as Meta;

  const files: Record<string, ArrayBuffer> = {};
  for (const layer of Object.values(meta.layers)) {
    const response = await fetchFn(base + layer.file);
    if (!response.ok) throw new Error(`${layer.file}: HTTP ${response.status}`);
    files[layer.file] = await response.arrayBuffer();
  }
  return parseSite(meta, files);
}
