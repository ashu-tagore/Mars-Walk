// Thin Web Worker message handler: docs/data-contract.md, sections 3 and 4.
// Messages are { type, payload }. All work happens in engine.ts.

import {
  Envelope,
  Params,
  Route,
  ShelterTimes,
  applyParams,
  defaultParams,
  planRoute,
  shelterTimes,
  walkback,
} from "./engine";
import { Grid, loadSite } from "./grid";
import { SciencePlan, SimState, planScience, simulate } from "./mission";

export type EngineMessage = { type: string; payload?: any };

export type EngineError = { type: "error"; request: string; message: string };

export type EngineReply =
  | { type: "siteLoaded"; width: number; height: number }
  | { type: "paramsSet" }
  | Route
  | Envelope
  | ShelterTimes
  | SciencePlan
  | SimState
  | EngineError;

export type EngineState = { grid: Grid | null; params: Params };

export function createState(): EngineState {
  return { grid: null, params: defaultParams() };
}

function requireGrid(state: EngineState): Grid {
  if (!state.grid) throw new Error("no site loaded (send loadSite first)");
  return state.grid;
}

// Exported so tests can drive the worker logic without a real Worker.
export async function handleMessage(state: EngineState, message: EngineMessage): Promise<EngineReply> {
  const request = message && typeof message.type === "string" ? message.type : "unknown";
  const payload = message?.payload ?? {};
  try {
    if (request === "loadSite") {
      state.grid = await loadSite(payload.siteUrl);
      return { type: "siteLoaded", width: state.grid.width, height: state.grid.height };
    }
    if (request === "setParams") {
      state.params = applyParams(state.params, payload.params ?? {});
      return { type: "paramsSet" };
    }
    if (request === "planRoute") {
      return planRoute(requireGrid(state), state.params, payload);
    }
    if (request === "walkback") {
      return walkback(requireGrid(state), state.params, payload);
    }
    if (request === "shelterTimes") {
      return shelterTimes(requireGrid(state), state.params, payload.from);
    }
    if (request === "planScience") {
      return planScience(requireGrid(state), state.params, payload);
    }
    if (request === "simulate") {
      return simulate(requireGrid(state), state.params, payload);
    }
    return { type: "error", request, message: `message type ${request} is not handled by this engine version` };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { type: "error", request, message: text };
  }
}

// Bind only inside a real worker, so Node tests can import this file.
const isWorker = typeof self !== "undefined" && typeof (self as any).postMessage === "function";
if (isWorker) {
  const state = createState();
  self.addEventListener("message", async (event: MessageEvent<EngineMessage>) => {
    const reply = await handleMessage(state, event.data);
    // The envelope mask moves to the app without a copy (also the one inside a simState).
    let transfer: ArrayBuffer[] = [];
    if (reply.type === "envelope") transfer = [reply.mask.buffer as ArrayBuffer];
    if (reply.type === "simState") transfer = [reply.envelope.mask.buffer as ArrayBuffer];
    self.postMessage(reply, transfer);
  });
}
