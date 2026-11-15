import { describe, expect, it } from "vitest";
import { cellToLatLng, gridBounds, latLngToCell, tileZoomOffset } from "./coords";

// Same shape as the real site meta.json: 1000 x 1000 cells of 3 m. Not terrain data, only the grid size.
const GRID = { width: 1000, height: 1000, cellSizeMeters: 3 };
// A non-square grid catches a swapped width and height.
const WIDE = { width: 40, height: 10, cellSizeMeters: 3 };

describe("cellToLatLng", () => {
  it("puts the north-west cell center half a cell in from the origin", () => {
    expect(cellToLatLng(GRID, { col: 0, row: 0 })).toEqual([-1.5, 1.5]);
  });

  it("puts all four corner cell centers half a cell inside the grid edges", () => {
    expect(cellToLatLng(GRID, { col: 999, row: 0 })).toEqual([-1.5, 2998.5]);
    expect(cellToLatLng(GRID, { col: 0, row: 999 })).toEqual([-2998.5, 1.5]);
    expect(cellToLatLng(GRID, { col: 999, row: 999 })).toEqual([-2998.5, 2998.5]);
  });

  it("moves south (more negative lat) as the row grows and east as the column grows", () => {
    const [lat, lng] = cellToLatLng(WIDE, { col: 30, row: 5 });
    expect(lat).toBe(-16.5);
    expect(lng).toBe(91.5);
  });
});

describe("latLngToCell", () => {
  it("returns the cell for its own center", () => {
    expect(latLngToCell(GRID, -1.5, 1.5)).toEqual({ col: 0, row: 0 });
    expect(latLngToCell(GRID, -2998.5, 2998.5)).toEqual({ col: 999, row: 999 });
  });

  it("finds the four corner cells from points just inside the grid corners", () => {
    const e = 0.001;
    expect(latLngToCell(GRID, -e, e)).toEqual({ col: 0, row: 0 });
    expect(latLngToCell(GRID, -e, 3000 - e)).toEqual({ col: 999, row: 0 });
    expect(latLngToCell(GRID, -3000 + e, e)).toEqual({ col: 0, row: 999 });
    expect(latLngToCell(GRID, -3000 + e, 3000 - e)).toEqual({ col: 999, row: 999 });
  });

  it("gives a cell its north and west edge", () => {
    expect(latLngToCell(GRID, 0, 0)).toEqual({ col: 0, row: 0 });
    expect(latLngToCell(GRID, -3, 3)).toEqual({ col: 1, row: 1 });
  });

  it("returns null on the east and south outer edges and outside the grid", () => {
    expect(latLngToCell(GRID, -10, 3000)).toBeNull();
    expect(latLngToCell(GRID, -3000, 10)).toBeNull();
    expect(latLngToCell(GRID, 0.001, 10)).toBeNull();
    expect(latLngToCell(GRID, -10, -0.001)).toBeNull();
  });

  it("does not swap columns and rows on a non-square grid", () => {
    expect(latLngToCell(WIDE, -16.5, 91.5)).toEqual({ col: 30, row: 5 });
    expect(latLngToCell(WIDE, -31, 10)).toBeNull();
    expect(latLngToCell(WIDE, -10, 119.9)).toEqual({ col: 39, row: 3 });
  });
});

describe("round trip", () => {
  it("cell -> latLng -> cell gives the same cell everywhere on the grid", () => {
    for (let row = 0; row < GRID.height; row += 37) {
      for (let col = 0; col < GRID.width; col += 41) {
        const [lat, lng] = cellToLatLng(GRID, { col, row });
        expect(latLngToCell(GRID, lat, lng)).toEqual({ col, row });
      }
    }
    for (const cell of [
      { col: 0, row: 0 },
      { col: 999, row: 0 },
      { col: 0, row: 999 },
      { col: 999, row: 999 },
    ]) {
      const [lat, lng] = cellToLatLng(GRID, cell);
      expect(latLngToCell(GRID, lat, lng)).toEqual(cell);
    }
  });
});

describe("gridBounds", () => {
  it("covers the grid from the origin to the south-east outer corner", () => {
    expect(gridBounds(GRID)).toEqual([
      [-3000, 0],
      [0, 3000],
    ]);
    expect(gridBounds(WIDE)).toEqual([
      [-30, 0],
      [0, 120],
    ]);
  });
});

describe("tileZoomOffset", () => {
  it("maps the real pyramid (0.5 m per pixel at level 5) to Leaflet zoom 1", () => {
    const offset = tileZoomOffset(5, 0.5);
    expect(offset).toBe(4);
    // Leaflet zoom 1 draws 2 pixels per meter = 0.5 m per pixel, the same as tile level 5.
    expect(1 + offset).toBe(5);
  });
});
