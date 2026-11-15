// All traffic with the engine Web Worker goes through this file (docs/data-contract.md, sections 3 and 4).
// It reads the plan from the store, sends contract messages, and writes the replies back into the store.
//
// Request ids: the contract replies carry no id. The worker answers strictly in the order it receives messages
// (each handler finishes before the next message event runs; loadSite is awaited before anything else is sent),
// so a FIFO queue tells which request each reply belongs to.
//
// Latest wins: each channel has at most one request in the worker. A new request while one is running waits,
// and a newer one replaces it. When a reply arrives whose id is not the newest id of its channel, it is dropped.
// So a fast slider drag costs at most two walk-back runs, not one per slider step, and the UI never freezes.

import type { Envelope, Route, ShelterTimes } from "../../engine/src/engine";
import { CONTRACT_VERSION } from "../../engine/src/grid";
import type { SciencePlan, SimState } from "../../engine/src/mission";
import { type MissionState, type SiteMeta, constantNumber, getState, subscribe, update } from "./store";

// docs/data-contract.md, sections 3 and 4. Built from the engine's own types. worker.ts is not imported here:
// it is Web Worker code and does not type-check against the page's DOM types.
type EngineMessage = { type: string; payload?: unknown };
type EngineReply =
  | { type: "siteLoaded"; width: number; height: number }
  | { type: "paramsSet" }
  | Route
  | Envelope
  | ShelterTimes
  | SciencePlan
  | SimState
  | { type: "error"; request: string; message: string };

type Channel = "site" | "route" | "timeline" | "science" | "contingency" | "shelter" | "params";

type Request = { id: number; channel: Channel; message: EngineMessage };

type InFlight = Request & { sentAtMs: number };

// The reply type each request expects (docs/data-contract.md, section 3). "error" is always possible.
const EXPECTED_REPLY: Record<string, string> = {
  loadSite: "siteLoaded",
  planRoute: "route",
  simulate: "simState",
  planScience: "sciencePlan",
  shelterTimes: "shelterTimes",
  setParams: "paramsSet",
};

let worker: Worker | null = null;
let nextId = 1;
const inFlight: InFlight[] = [];
const latestId: Record<Channel, number> = { site: 0, route: 0, timeline: 0, science: 0, contingency: 0, shelter: 0, params: 0 };
const waiting: Record<Channel, Request | null> = {
  site: null,
  route: null,
  timeline: null,
  science: null,
  contingency: null,
  shelter: null,
  params: null,
};
let siteLoaded = false;
// The settings the engine last accepted. A rejected setParams puts the store back to these.
let acceptedParams: MissionState["params"] = {};

// Loads meta.json for the map and panels, starts the worker and asks it to load the same site.
// siteUrl must be absolute: the worker resolves relative URLs against its own script location.
export async function openSite(siteUrl: string): Promise<void> {
  update({ siteUrl, engine: { status: "loading", error: null, lastCalc: null } });

  let meta: SiteMeta;
  try {
    const response = await fetch(siteUrl + "meta.json");
    if (!response.ok) throw new Error(`meta.json: HTTP ${response.status}`);
    meta = (await response.json()) as SiteMeta;
    // Check before the map and panels read any field: a different version may have a different schema.
    if (meta.version !== CONTRACT_VERSION) {
      throw new Error(`meta.json version ${meta.version} is not supported (app reads version ${CONTRACT_VERSION})`);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    update({ engine: { status: "error", error: `Cannot load site data: ${text}`, lastCalc: null } });
    return;
  }

  const layers = { ...getState().layers };
  for (const overlay of meta.overlays) layers[overlay.id] = false;
  update({ meta, layers });

  worker = new Worker(new URL("../../engine/src/worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<EngineReply>) => onReply(event.data));
  worker.addEventListener("error", (event) => {
    update({ engine: { ...getState().engine, status: "error", error: `Engine worker failed: ${event.message}` } });
  });
  subscribe(onStoreChange);
  send("site", { type: "loadSite", payload: { siteUrl } });
}

function onStoreChange(state: MissionState, previous: MissionState): void {
  if (!siteLoaded) return;
  if (state.params !== previous.params) {
    // After a rejected change the store goes back to the accepted settings, which the engine already has.
    const isRollback = state.params === acceptedParams;
    if (!isRollback) requestParams(state);
    return;
  }
  const scienceRequested = state.scienceStatus === "requested" && previous.scienceStatus !== "requested";
  if (scienceRequested) {
    requestScience();
    return;
  }
  const planChanged = state.stops !== previous.stops || state.start !== previous.start || state.end !== previous.end;
  if (planChanged) {
    requestRoute();
    requestTimeline();
    return;
  }
  const timelineChanged = state.elapsedS !== previous.elapsedS || state.buddyDelayS !== previous.buddyDelayS;
  if (timelineChanged) {
    requestTimeline();
    return;
  }
  if (state.scenario !== previous.scenario) requestContingency();
}

// The plan in contract form. A missing start or end is the habitat (docs/data-contract.md, planRoute).
function planPayload(state: MissionState): { start?: { col: number; row: number }; end?: { col: number; row: number }; stops: { col: number; row: number }[] } {
  const payload: ReturnType<typeof planPayload> = { stops: state.stops };
  if (state.start) payload.start = state.start;
  if (state.end) payload.end = state.end;
  return payload;
}

function requestRoute(): void {
  send("route", { type: "planRoute", payload: planPayload(getState()) });
}

// Decision 1 (approved by the project owner): the timeline uses simulate with scenario "none".
// Its envelope is walkback({ elapsedS, usedJ, position }) with usedJ and position taken from the plan timeline
// (docs/data-contract.md, section 4.1). The app cannot compute usedJ itself without doing physics.
// A contingency is asked for at the same moment, so it follows every timeline request.
function requestTimeline(): void {
  send("timeline", { type: "simulate", payload: simulatePayload(getState(), "none") });
  requestContingency();
}

// The event happens at the slider time. Astronaut A is the display crewmember: in "buddy_injured" A is the rescuer
// and B is injured (docs/data-contract.md, section 4.1).
function requestContingency(): void {
  const state = getState();
  if (state.scenario === "none") {
    if (state.contingency || state.contingencyError) update({ contingency: null, contingencyError: null });
    return;
  }
  send("contingency", { type: "simulate", payload: simulatePayload(state, state.scenario) });
}

function simulatePayload(state: MissionState, scenario: MissionState["scenario"]) {
  const delaysS = { A: 0, B: state.buddyDelayS };
  return { scenario, atTimeS: state.elapsedS, astronaut: "A", delaysS, ...planPayload(state) };
}

// setParams changes only the names it is given (engine applyParams). Each message carries every name the user ever
// set: a reset one with its docs/assumptions.md value (EVA_ENERGY_BUDGET_J: null = derived). So any one message gives
// the full intended state, and "latest wins" may drop the ones before it.
const touchedParams = new Set<string>();

function requestParams(state: MissionState): void {
  for (const name of Object.keys(state.params)) touchedParams.add(name);
  const params: Record<string, number | null> = {};
  for (const name of touchedParams) {
    const setting = state.params[name];
    const docsValue = name === "EVA_ENERGY_BUDGET_J" ? null : constantNumber(state.meta, name);
    params[name] = setting === undefined ? docsValue : setting;
  }
  if (touchedParams.size === 0) return;
  send("params", { type: "setParams", payload: { params } });
}

// Defaults of docs/data-contract.md: budgetJ = EVA_ENERGY_BUDGET_J, every meta.json waypoint is a candidate.
function requestScience(): void {
  update({ scienceStatus: "running", scienceError: null });
  send("science", { type: "planScience", payload: {} });
}

function send(channel: Channel, message: EngineMessage): void {
  const request: Request = { id: nextId++, channel, message };
  latestId[channel] = request.id;
  const channelBusy = inFlight.some((item) => item.channel === channel);
  if (channelBusy) waiting[channel] = request;
  else post(request);
  refreshStatus();
}

function post(request: Request): void {
  if (!worker) return;
  inFlight.push({ ...request, sentAtMs: performance.now() });
  worker.postMessage(request.message);
}

function onReply(reply: EngineReply): void {
  const request = inFlight.shift();
  if (!request) {
    console.error("Engine reply without a request", reply.type);
    return;
  }
  const roundTripMs = performance.now() - request.sentAtMs;

  // Start the newest waiting request of this channel before handling the reply, so the worker stays busy.
  const next = waiting[request.channel];
  if (next) {
    waiting[request.channel] = null;
    post(next);
  }

  const isStale = request.id !== latestId[request.channel];
  if (!isStale) applyReply(request, reply, roundTripMs);
  refreshStatus();
}

function applyReply(request: InFlight, reply: EngineReply, roundTripMs: number): void {
  const lastCalc = { request: request.message.type, ms: roundTripMs };
  const engine = { ...getState().engine, lastCalc };

  const expected = EXPECTED_REPLY[request.message.type];
  const unexpected = reply.type !== "error" && reply.type !== expected;
  if (unexpected) {
    update({ engine: { ...engine, status: "error", error: `Engine sent ${reply.type} for ${request.message.type}` } });
    return;
  }

  if (reply.type === "error") {
    applyError(request.channel, reply.message, engine);
    return;
  }
  if (reply.type === "siteLoaded") {
    siteLoaded = true;
    update({ engine: { ...engine, error: null } });
    requestRoute();
    requestTimeline();
    return;
  }
  if (reply.type === "route") {
    update({ route: reply, routeError: null, engine });
    return;
  }
  if (reply.type === "sciencePlan") {
    // The planner works habitat -> habitat, so start and end go back to the habitat. The new stops start a planRoute
    // (onStoreChange); reply.route is the same planRoute result, so it is shown right away.
    update({
      sciencePlan: reply,
      scienceStatus: "idle",
      scienceError: null,
      stops: reply.stops,
      start: null,
      end: null,
      selectedStop: null,
      placing: "stop",
      route: reply.route,
      routeError: null,
      engine,
    });
    return;
  }
  if (reply.type === "simState" && request.channel === "contingency") {
    // A reply for a scenario the user has since switched off is not shown.
    const stillWanted = getState().scenario === reply.scenario;
    update({ contingency: stillWanted ? reply : null, contingencyError: null, engine });
    return;
  }
  if (reply.type === "paramsSet") {
    // Every engine number depends on the settings: plan, timeline and shelter times again.
    acceptedParams = getState().params;
    update({ paramsError: null, engine });
    requestRoute();
    requestTimeline();
    const crewCell = getState().crewCell;
    if (crewCell) send("shelter", { type: "shelterTimes", payload: { from: crewCell } });
    return;
  }
  if (reply.type === "shelterTimes") {
    update({ shelterTimes: reply, engine });
    return;
  }
  if (reply.type === "simState") {
    // Astronaut A is the crewmember this display is for (simulate payload `astronaut`).
    const crew = reply.astronauts.find((astronaut) => astronaut.id === "A") ?? null;
    const previousCell = getState().crewCell;
    const moved = crew !== null && (previousCell === null || previousCell.col !== crew.cell.col || previousCell.row !== crew.cell.row);
    if (moved) send("shelter", { type: "shelterTimes", payload: { from: crew.cell } });
    update({
      sim: reply,
      envelope: reply.envelope,
      usedJ: crew ? crew.usedJ : null,
      crewCell: crew ? crew.cell : null,
      timelineError: null,
      engine,
    });
  }
}

function applyError(channel: Channel, message: string, engine: MissionState["engine"]): void {
  if (channel === "site") {
    update({ engine: { ...engine, status: "error", error: `Engine cannot load the site: ${message}` } });
    return;
  }
  if (channel === "route") {
    update({ route: null, routeError: message, engine });
    return;
  }
  if (channel === "science") {
    update({ scienceStatus: "idle", scienceError: message, engine });
    return;
  }
  if (channel === "contingency") {
    update({ contingency: null, contingencyError: message, engine });
    return;
  }
  if (channel === "shelter") {
    update({ shelterTimes: null, engine });
    return;
  }
  if (channel === "params") {
    // The engine keeps its old values when it rejects a change (applyParams throws before it assigns).
    update({ params: acceptedParams, paramsError: message, engine });
    return;
  }
  update({ sim: null, envelope: null, usedJ: null, crewCell: null, timelineError: message, engine });
}

function refreshStatus(): void {
  const engine = getState().engine;
  if (engine.status === "error" && !siteLoaded) return;
  const busy = inFlight.length > 0;
  let status: MissionState["engine"]["status"] = busy ? "calculating" : "ready";
  if (!siteLoaded) status = "loading";
  if (status === engine.status) return;
  update({ engine: { ...engine, status } });
}
