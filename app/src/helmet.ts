// Helmet mode: a high-contrast crew display with quick commands and spoken answers (docs/data-contract.md, section 5).
// The parser is deterministic keyword matching; the quick-command buttons and the typed command box use the same intents.
// Every answer is built from store state (engine replies and meta.json), never computed here.
// Browser speech recognition is not built (docs/build-plan.md, app scope). Spoken answers use speechSynthesis,
// which works offline with the voices of the operating system.

import { DEPENDS, assumptionTag, formatClock, formatDistance, formatDuration, withTag } from "./panels";
import { type MissionState, constantNumber, getState, paramNumber, subscribe, update } from "./store";

export type Intent = "QUERY_TURN_BACK" | "QUERY_NEXT_STOP" | "QUERY_BUDDY" | "QUERY_SHELTER" | "QUERY_RADIATION";

export type Answer = { text: string; depends: string[] };

// Checked in this order, first match wins. "next stop" is last, because "stop" is the most general word.
const INTENT_KEYWORDS: [Intent, string[]][] = [
  ["QUERY_TURN_BACK", ["turn back", "turnback", "turn around", "go back", "return"]],
  ["QUERY_BUDDY", ["buddy", "partner", "crew b"]],
  ["QUERY_SHELTER", ["shelter"]],
  ["QUERY_RADIATION", ["radiation", "solar", "storm", "dose"]],
  ["QUERY_NEXT_STOP", ["next stop", "next", "stop"]],
];

// The five intents of docs/data-contract.md, section 5, with their quick-command button labels.
const COMMANDS: { intent: Intent; label: string; tile: string }[] = [
  { intent: "QUERY_NEXT_STOP", label: "Next stop", tile: "Next stop" },
  { intent: "QUERY_TURN_BACK", label: "Turn back time", tile: "Turn back" },
  { intent: "QUERY_BUDDY", label: "Where is my buddy", tile: "Buddy" },
  { intent: "QUERY_SHELTER", label: "Nearest shelter", tile: "Shelter" },
  { intent: "QUERY_RADIATION", label: "Radiation status", tile: "Radiation" },
];

const NOT_RECOGNIZED = "Command not recognized. Try: next stop, turn back, buddy, shelter, radiation.";

export function matchIntent(phrase: string): Intent | null {
  const text = phrase.toLowerCase().replace(/[^a-z ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  for (const [intent, keywords] of INTENT_KEYWORDS) {
    if (keywords.some((keyword) => text.includes(keyword))) return intent;
  }
  return null;
}

export function answer(intent: Intent, state: MissionState): Answer {
  if (intent === "QUERY_TURN_BACK") return turnBackAnswer(state);
  if (intent === "QUERY_NEXT_STOP") return nextStop(state).answer;
  if (intent === "QUERY_BUDDY") return buddyAnswer(state);
  if (intent === "QUERY_SHELTER") return shelterAnswer(state);
  return radiationAnswer(state);
}

// Answer source: Envelope.turnBackAtS.
function turnBackAnswer(state: MissionState): Answer {
  const depends = DEPENDS.turnBack;
  if (!state.envelope) return { text: "Turn-back time not available yet.", depends: [] };
  const turnBackS = state.envelope.turnBackAtS;
  const leftS = turnBackS - state.elapsedS;
  if (leftS <= 0) return { text: "Turn back now. Return to the habitat.", depends };
  return { text: `Turn back in ${formatDuration(leftS)}, at EVA time ${formatClock(turnBackS)}.`, depends };
}

// Answer source: Route.legs. Each leg ends at a stop (except the last, which ends at the end point); the crew stays
// route.stopTimeS / stops at each stop. Same timing as the engine timeline (docs/data-contract.md, section 4.1).
export function nextStop(state: MissionState): { answer: Answer; stopId: string | null } {
  const depends = [...DEPENDS.route, ...DEPENDS.timeline];
  const route = state.route;
  if (!route || route.legs.length === 0) return { answer: { text: "No route planned.", depends: [] }, stopId: null };

  const stopCount = route.legs.length - 1;
  const dwellS = stopCount > 0 ? route.stopTimeS / stopCount : 0;
  let arriveS = 0;
  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i];
    arriveS += leg.timeS;
    const name = placeName(state, leg.to);
    const isLast = i === route.legs.length - 1;
    if (state.elapsedS < arriveS) {
      const kind = isLast ? "Last leg to" : "Next stop";
      const text = `${kind} ${name}, ${formatDistance(leg.distanceM)} leg, arrive at EVA time ${formatClock(arriveS)}.`;
      return { answer: { text, depends }, stopId: leg.to };
    }
    if (isLast) break;
    const leaveS = arriveS + dwellS;
    if (state.elapsedS < leaveS) {
      const after = placeName(state, route.legs[i + 1].to);
      return { answer: { text: `At ${name} until EVA time ${formatClock(leaveS)}. Then ${after}.`, depends }, stopId: leg.to };
    }
    arriveS = leaveS;
  }
  const end = placeName(state, route.legs[route.legs.length - 1].to);
  return { answer: { text: `All stops done. The plan ends at ${end}.`, depends }, stopId: null };
}

// Route leg names are "habitat", a waypoint, shelter or pickup zone id, or "col,row" (docs/data-contract.md, section 4).
function placeName(state: MissionState, id: string): string {
  const waypoint = state.meta?.waypoints.find((point) => point.id === id);
  if (waypoint) return `${id} (${waypoint.name})`;
  if (id.includes(",")) return `cell ${id}`;
  return id;
}

// Answer source: SimState.separationM.
function buddyAnswer(state: MissionState): Answer {
  const depends = DEPENDS.buddy;
  if (!state.sim) return { text: "Buddy position not available yet.", depends: [] };
  const separationM = state.sim.separationM;
  const limitM = paramNumber(state, "BUDDY_MAX_SEPARATION_M");
  const distance = `Buddy B is ${formatDistance(separationM)} away.`;
  if (limitM === null) return { text: distance, depends };
  if (separationM > limitM) return { text: `${distance} Above the ${limitM} m limit: close the gap.`, depends };
  return { text: `${distance} Within the ${limitM} m limit.`, depends };
}

// Answer source: ShelterTimes.options[0]. During a solar particle alert, the shelter the simulator chose instead
// (the crew goes together, docs/data-contract.md, section 4.1).
function shelterAnswer(state: MissionState): Answer {
  const alert = state.scenario === "sep_event" ? state.contingency : null;
  if (alert && alert.actionTargetId) {
    const text = `Solar particle alert: go to ${alert.actionTargetId}, ${formatDuration(alert.actionTimeS)} walk.`;
    return { text, depends: DEPENDS.sepEvent };
  }
  const depends = ["FULL_SHELTERS"];
  const options = state.shelterTimes ? state.shelterTimes.options : null;
  if (!options) return { text: "Shelter times not available yet.", depends: [] };
  const nearest = options[0];
  if (!nearest) return { text: "No full shelter can be reached on foot from here.", depends };
  return { text: `Nearest full shelter: ${nearest.shelterId}, ${formatDuration(nearest.timeS)} walk.`, depends };
}

// Answer source: docs/assumptions.md (radiation rows) and the active scenario. The alert is simulated (project brief, section 6).
function radiationAnswer(state: MissionState): Answer {
  if (state.scenario === "sep_event") {
    const alert = state.contingency;
    const go = alert && alert.actionTargetId ? ` Go to ${alert.actionTargetId} now, ${formatDuration(alert.actionTimeS)} walk.` : "";
    return { text: `Simulated solar particle alert. Charged particles can arrive in tens of minutes.${go}`, depends: DEPENDS.sepEvent };
  }
  const doseMsv = constantNumber(state.meta, "GCR_DOSE_MSV_PER_DAY");
  const dose = doseMsv === null ? "" : ` Background dose about ${doseMsv} mSv per day (Curiosity RAD).`;
  return { text: `No solar particle alert.${dose} Full shelters: habitat and rover.`, depends: ["FULL_SHELTERS", "GCR_DOSE_MSV_PER_DAY"] };
}

// ---- View ----

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function speak(text: string): boolean {
  const synth = window.speechSynthesis;
  if (!synth) return false;
  synth.cancel(); // a new answer replaces the one being spoken
  synth.speak(new SpeechSynthesisUtterance(text));
  return true;
}

export function createHelmet(container: HTMLElement): void {
  const root = el("div", "helmet");
  root.hidden = true;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Helmet mode");

  const head = el("div", "helmet-head");
  const exit = el("button", "helmet-exit", "Exit helmet mode");
  exit.type = "button";
  exit.addEventListener("click", () => update({ helmet: false }));
  head.append(el("span", "helmet-title", "HELMET MODE"), exit);

  const tiles = el("div", "helmet-tiles");
  const tileValues = new Map<Intent, HTMLElement>();
  for (const command of COMMANDS) {
    const tile = el("div", "helmet-tile");
    const value = el("div", "helmet-value");
    tile.append(el("div", "helmet-label", command.tile), value);
    tiles.append(tile);
    tileValues.set(command.intent, value);
  }

  const pov = el("figure", "helmet-pov");
  const povImage = el("img");
  povImage.alt = "Curiosity image taken at the next stop";
  const povCaption = el("figcaption");
  pov.append(povImage, povCaption);

  const commands = el("div", "helmet-commands");
  const lastAnswer = el("div", "helmet-answer");
  lastAnswer.setAttribute("aria-live", "polite");
  const run = (intent: Intent | null): void => {
    const text = intent ? answer(intent, getState()).text : NOT_RECOGNIZED;
    const spoken = speak(text);
    lastAnswer.textContent = spoken ? text : `${text} (Spoken answers are not available in this browser.)`;
  };
  for (const command of COMMANDS) {
    const button = el("button", "helmet-command", command.label);
    button.type = "button";
    button.addEventListener("click", () => run(command.intent));
    commands.append(button);
  }
  const input = el("input", "helmet-input");
  input.type = "text";
  input.placeholder = "Type a command, then Enter";
  input.setAttribute("aria-label", "Command");
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    run(matchIntent(input.value));
    input.value = "";
  });
  commands.append(input);

  const body = el("div", "helmet-body");
  body.append(tiles, pov);
  root.append(head, body, commands, lastAnswer);
  container.append(root);

  const render = (state: MissionState): void => {
    const wasHidden = root.hidden;
    root.hidden = !state.helmet;
    if (!state.helmet) return;
    if (wasHidden) exit.focus();
    for (const command of COMMANDS) {
      const result = answer(command.intent, state);
      const value = tileValues.get(command.intent) as HTMLElement;
      value.replaceChildren(withTag(el("span", "", result.text), assumptionTag(state.meta, result.depends)));
    }
    const stopId = nextStop(state).stopId;
    const waypoint = stopId ? state.meta?.waypoints.find((point) => point.id === stopId) : undefined;
    const hasPov = waypoint !== undefined && waypoint.pov !== null;
    pov.hidden = !hasPov;
    if (!hasPov) return;
    const src = state.siteUrl + waypoint.pov;
    if (povImage.getAttribute("src") !== src) povImage.src = src;
    povCaption.textContent = `${waypoint.id}: ${waypoint.name}. ${waypoint.povCredit ?? ""}`;
  };
  subscribe((state) => render(state));
  render(getState());
}
