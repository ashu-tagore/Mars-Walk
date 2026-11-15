// The ONE mission store. Every UI part reads from it and writes to it; nothing else holds mission state.
// Plain object state, update(partial) replaces the top-level keys it is given, subscribe(listener) is told about
// every update with the new and the previous state (compare keys by reference to see what changed).

import type { Envelope, Route, ShelterTimes } from "../../engine/src/engine";
import type { ConstantEntry, Meta, OverlayInfo } from "../../engine/src/grid";
import type { SciencePlan, SimState } from "../../engine/src/mission";
import type { Cell } from "./coords";

export type { Cell, ConstantEntry, Envelope, OverlayInfo, Route, SciencePlan, ShelterTimes, SimState };

// meta.json (docs/data-contract.md, section 2). One type shared with the engine, so the two cannot drift apart.
export type SiteMeta = Meta;

// ---- Mission state ----

// Layer ids: "basemap", "envelope", "route", "markers", plus every meta.json overlay id.
export type LayerVisibility = Record<string, boolean>;

// What the next click on the map sets.
export type PlacingMode = "stop" | "start" | "end";

export type EngineStatus = "loading" | "ready" | "calculating" | "error";

// A panel sets "requested"; the engine client sends planScience, sets "running", and back to "idle" on the reply.
export type ScienceStatus = "idle" | "requested" | "running";

// simulate scenarios (docs/data-contract.md, section 3). "none" = no event.
export type Scenario = "none" | "sep_event" | "buddy_injured";

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
  // Science planner. The plan's stops array becomes `stops`, so `stops === sciencePlan.stops` means the user has not
  // edited the plan since.
  scienceStatus: ScienceStatus;
  sciencePlan: SciencePlan | null;
  scienceError: string | null;
  // Timeline (EVA time slider). The engine fills envelope, usedJ, crewCell and sim from a simulate("none") reply.
  elapsedS: number;
  // Astronaut B walks the same plan this many seconds behind A (simulate delaysS.B). 0 = together.
  // Starts at BUDDY_LAG_S (docs/assumptions.md) when meta.json loads.
  buddyDelayS: number;
  // The user dragged B on the map: B stands here instead of on the timeline (simulate bPosition). null = timeline.
  bPosition: Cell | null;
  // Who is injured in "buddy_injured" (simulate injured). The other crewmember is the rescuer.
  injured: "A" | "B";
  usedJ: number | null;
  crewCell: Cell | null;
  envelope: Envelope | null;
  sim: SimState | null;
  timelineError: string | null;
  // Contingency: a second simulate with this scenario at the same time and plan. `sim` stays scenario "none", so the
  // energy budget and turn-back time keep their meaning; the map shows the contingency envelope and action path.
  scenario: Scenario;
  contingency: SimState | null;
  contingencyError: string | null;
  // Full shelters from crew A's cell, fastest first (engine shelterTimes). Asked again whenever crew A moves.
  shelterTimes: ShelterTimes | null;
  // Helmet mode: the high-contrast crew display with quick commands and spoken answers.
  helmet: boolean;
  // Settings: docs/assumptions.md "Adjustable" values the user changed, by name. A missing name = the docs value.
  // EVA_ENERGY_BUDGET_J null = derived from EVA_DURATION_H (engine Params). The engine client sends them with setParams.
  params: Record<string, number | null>;
  paramsError: string | null;
  aboutOpen: boolean;
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
    scienceStatus: "idle",
    sciencePlan: null,
    scienceError: null,
    elapsedS: 0,
    buddyDelayS: 0,
    bPosition: null,
    injured: "B",
    usedJ: null,
    crewCell: null,
    envelope: null,
    sim: null,
    timelineError: null,
    scenario: "none",
    contingency: null,
    contingencyError: null,
    shelterTimes: null,
    helmet: false,
    params: {},
    paramsError: null,
    aboutOpen: false,
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

// ---- Constants ----

// meta.json `constants` values are the text of the docs/assumptions.md Value column, for example "6 (range 4 to 8)".
// The number is the leading part. Returns null when the text does not start with a number.
export function constantNumber(meta: SiteMeta | null, name: string): number | null {
  const entry = meta?.constants[name];
  if (!entry) return null;
  const match = entry.value.trim().match(/^-?\d+(\.\d+)?(e[+-]?\d+)?/i);
  return match ? Number(match[0]) : null;
}

// The value the engine uses now: the user's setting if there is one, else the docs/assumptions.md value.
export function paramNumber(current: MissionState, name: string): number | null {
  const setting = current.params[name];
  if (typeof setting === "number") return setting;
  return constantNumber(current.meta, name);
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
