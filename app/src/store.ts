// The ONE mission store. Every UI part reads from it and writes to it; nothing else holds mission state.
// Plain object state, update(partial) replaces the top-level keys it is given, subscribe(listener) is told about
// every update with the new and the previous state (compare keys by reference to see what changed).

import type { Envelope, Route } from "../../engine/src/engine";
import type { SimState } from "../../engine/src/mission";
import type { Cell } from "./coords";

export type { Cell, Envelope, Route, SimState };

// ---- meta.json (docs/data-contract.md, section 2) ----

export type ConstantEntry = { value: string; status: "SOURCED" | "ASSUMPTION" | "DEFINITION"; source: string };

export type OverlayInfo = {
  id: string;
  file: string;
  label: string;
  description: string;
  source: string;
  assumption: boolean;
};

export type SiteMeta = {
  version: number;
  site: string;
  name: string;
  width: number;
  height: number;
  cellSizeMeters: number;
  crs: string;
  transform: number[];
  bounds: { west: number; south: number; east: number; north: number };
  byteOrder: string;
  rowOrder: string;
  noData: number;
  layers: Record<string, { file: string; type: string }>;
  tiles: {
    path: string;
    tileSize: number;
    minZoom: number;
    maxZoom: number;
    metersPerPixelAtMaxZoom: number;
    widthPx: number;
    heightPx: number;
    source: string;
  };
  overlays: OverlayInfo[];
  habitat: Cell & { source?: string };
  shelters: (Cell & { id: string; kind: "full" | "partial"; source?: string })[];
  roverPickupZones: (Cell & { id: string; areaM2: number })[];
  waypoints: (Cell & {
    id: string;
    name: string;
    scienceValue: number;
    sol: number;
    roverSite: number;
    roverDrive: number;
    source: string;
    pov: string | null;
    povCredit: string | null;
  })[];
  sources: { id: string; label: string; credit: string; url: string }[];
  notes: { id: string; text: string }[];
  constants: Record<string, ConstantEntry>;
};

// ---- Mission state ----

// Layer ids: "basemap", "envelope", "route", "markers", plus every meta.json overlay id.
export type LayerVisibility = Record<string, boolean>;

// What the next click on the map sets.
export type PlacingMode = "stop" | "start" | "end";

export type EngineStatus = "loading" | "ready" | "calculating" | "error";

export type MissionState = {
  meta: SiteMeta | null;
  siteUrl: string; // absolute URL of the site folder, ends with "/"
  layers: LayerVisibility;
  placing: PlacingMode;
  start: Cell | null; // null = habitat (docs/data-contract.md, planRoute)
  end: Cell | null; // null = habitat
  stops: Cell[];
  selectedStop: number | null; // index into stops
  route: Route | null;
  routeError: string | null;
  // Timeline (EVA time slider). The engine fills envelope, usedJ, crewCell and sim from a simulate("none") reply.
  elapsedS: number;
  usedJ: number | null;
  crewCell: Cell | null;
  envelope: Envelope | null;
  sim: SimState | null;
  timelineError: string | null;
  engine: {
    status: EngineStatus;
    error: string | null;
    // Round trip of the last engine reply that reached the store, measured in the app.
    lastCalc: { request: string; ms: number } | null;
  };
  offlineReady: boolean;
};

export type Listener = (state: MissionState, previous: MissionState) => void;

function initialState(): MissionState {
  return {
    meta: null,
    siteUrl: "",
    layers: { basemap: true, envelope: true, route: true, markers: true },
    placing: "stop",
    start: null,
    end: null,
    stops: [],
    selectedStop: null,
    route: null,
    routeError: null,
    elapsedS: 0,
    usedJ: null,
    crewCell: null,
    envelope: null,
    sim: null,
    timelineError: null,
    engine: { status: "loading", error: null, lastCalc: null },
    offlineReady: false,
  };
}

let state: MissionState = initialState();
const listeners = new Set<Listener>();

export function getState(): MissionState {
  return state;
}

export function update(partial: Partial<MissionState>): void {
  const previous = state;
  state = { ...state, ...partial };
  for (const listener of listeners) listener(state, previous);
}

// Returns a function that removes the listener.
export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ---- Small write helpers used by the map and the panels, so both change the plan the same way ----

export function addStop(cell: Cell): void {
  const stops = [...state.stops, cell];
  update({ stops, selectedStop: stops.length - 1 });
}

export function moveStop(index: number, cell: Cell): void {
  const stops = state.stops.map((stop, i) => (i === index ? cell : stop));
  update({ stops, selectedStop: index });
}

export function removeStop(index: number): void {
  const stops = state.stops.filter((_, i) => i !== index);
  update({ stops, selectedStop: null });
}

export function setLayerVisible(id: string, visible: boolean): void {
  update({ layers: { ...state.layers, [id]: visible } });
}
