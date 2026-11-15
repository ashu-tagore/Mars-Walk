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
import type { SciencePlan, SimState } from "../../engine/src/mission";
import { type MissionState, type SiteMeta, getState, subscribe, update } from "./store";

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

type Channel = "site" | "route" | "timeline";

type Request = { id: number; channel: Channel; message: EngineMessage };

type InFlight = Request & { sentAtMs: number };

// The reply type each request expects (docs/data-contract.md, section 3). "error" is always possible.
const EXPECTED_REPLY: Record<string, string> = { loadSite: "siteLoaded", planRoute: "route", simulate: "simState" };

let worker: Worker | null = null;
let nextId = 1;
const inFlight: InFlight[] = [];
const latestId: Record<Channel, number> = { site: 0, route: 0, timeline: 0 };
const waiting: Record<Channel, Request | null> = { site: null, route: null, timeline: null };
let siteLoaded = false;

// Loads meta.json for the map and panels, starts the worker and asks it to load the same site.
// siteUrl must be absolute: the worker resolves relative URLs against its own script location.
export async function openSite(siteUrl: string): Promise<void> {
  update({ siteUrl, engine: { status: "loading", error: null, lastCalc: null } });

  let meta: SiteMeta;
  try {
    const response = await fetch(siteUrl + "meta.json");
    if (!response.ok) throw new Error(`meta.json: HTTP ${response.status}`);
    meta = (await response.json()) as SiteMeta;
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
  const planChanged = state.stops !== previous.stops || state.start !== previous.start || state.end !== previous.end;
  if (planChanged) {
    requestRoute();
    requestTimeline();
    return;
  }
  if (state.elapsedS !== previous.elapsedS) requestTimeline();
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
function requestTimeline(): void {
  const state = getState();
  const payload = { scenario: "none", atTimeS: state.elapsedS, astronaut: "A", ...planPayload(state) };
  send("timeline", { type: "simulate", payload });
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
  if (reply.type === "simState") {
    // Astronaut A is the crewmember this display is for (simulate payload `astronaut`).
    const crew = reply.astronauts.find((astronaut) => astronaut.id === "A") ?? null;
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
