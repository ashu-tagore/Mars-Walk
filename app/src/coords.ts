// The ONLY place that converts grid cells <-> map coordinates.
//
// The map uses Leaflet's L.CRS.Simple with one map unit = one meter. The origin (0, 0) is the north-west corner
// of the grid (meta.json `bounds`). lng grows to the east, lat is negative and grows towards the north,
// so a cell further south has a more negative lat. This matches the tile pyramid in docs/data-contract.md,
// section 1.1: tile (0, 0) has its north-west corner at the grid's north-west corner, x east, y south.
//
// This file does not import Leaflet, so the tests run in Node without a DOM.

export type Cell = { col: number; row: number };

// [lat, lng] in meters, in the order Leaflet expects.
export type MapPoint = [number, number];

// [[south, west], [north, east]] in meters, in the order Leaflet expects.
export type MapBounds = [MapPoint, MapPoint];

export type GridShape = { width: number; height: number; cellSizeMeters: number };

// Center of a cell.
export function cellToLatLng(grid: GridShape, cell: Cell): MapPoint {
  const lat = -(cell.row + 0.5) * grid.cellSizeMeters;
  const lng = (cell.col + 0.5) * grid.cellSizeMeters;
  return [lat, lng];
}

// The cell that contains a map point, or null outside the grid.
// Each cell owns its north and west edge, so the grid's east and south outer edges are outside.
export function latLngToCell(grid: GridShape, lat: number, lng: number): Cell | null {
  const col = Math.floor(lng / grid.cellSizeMeters);
  // "0 - x" instead of "-x": on the north edge (lat 0) "-x" gives -0, which is not the same as row 0 for strict checks.
  const row = Math.floor(0 - lat / grid.cellSizeMeters);
  const colInside = col >= 0 && col < grid.width;
  const rowInside = row >= 0 && row < grid.height;
  if (!colInside || !rowInside) return null;
  return { col, row };
}

// Outer edges of the grid. Image overlays (orthophoto fallback, overlays/*.png, the envelope canvas) use these.
export function gridBounds(grid: GridShape): MapBounds {
  const south = -grid.height * grid.cellSizeMeters;
  const east = grid.width * grid.cellSizeMeters;
  return [
    [south, 0],
    [0, east],
  ];
}

// Leaflet zoom z in CRS.Simple draws one map unit (meter) as 2^z screen pixels.
// The pipeline tile level `tiles.maxZoom` draws metersPerPixelAtMaxZoom meters per pixel, and each lower level doubles it
// (docs/data-contract.md, section 1.1). So tile level = Leaflet zoom + offset, with
// offset = maxZoom + log2(metersPerPixelAtMaxZoom). For 0.5 m per pixel at level 5 the offset is 4.
export function tileZoomOffset(maxTileZoom: number, metersPerPixelAtMaxZoom: number): number {
  return maxTileZoom + Math.log2(metersPerPixelAtMaxZoom);
}

export function sameCell(a: Cell | null, b: Cell | null): boolean {
  if (!a || !b) return false;
  return a.col === b.col && a.row === b.row;
}
