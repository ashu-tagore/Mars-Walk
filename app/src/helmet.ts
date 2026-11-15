// Helmet mode: a full-screen, high-contrast crew display with quick commands and spoken answers (docs/data-contract.md,
// section 5). It shows only: the current turn-by-turn step (Route.instructions) with a big arrow, distance to the next
// stop, time to turn back, buddy distance, radiation status and the Curiosity image of the next stop. During a
// contingency the recommended action replaces the step.
// The parser is deterministic keyword matching; the quick-command buttons and the typed command box use the same intents.
// Every answer is built from store state (engine replies and meta.json), never computed here.
// Spoken answers use speechSynthesis, which works offline with the voices of the operating system.
// Browser speech recognition is optional, behind a mic button, only where the browser has it. Some browsers send the
// audio to an online service, so it may need internet; the quick-command buttons always work offline.

import { DEPENDS, PEAK_LABEL, assumptionTag, crewDistanceM, formatClock, formatDistance, formatDuration, withTag } from "./panels";
import { type MissionState, type SimState, constantNumber, getState, paramNumber, subscribe, update } from "./store";

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
const COMMANDS: { intent: Intent; label: string }[] = [
  { intent: "QUERY_NEXT_STOP", label: "Next stop" },
  { intent: "QUERY_TURN_BACK", label: "Turn back time" },
  { intent: "QUERY_BUDDY", label: "Where is my buddy" },
  { intent: "QUERY_SHELTER", label: "Nearest shelter" },
  { intent: "QUERY_RADIATION", label: "Radiation status" },
];

const NOT_RECOGNIZED = "Command not recognized. Try: next stop, turn back, buddy, shelter, radiation.";
const RECOGNITION_NOTE = "Speech recognition may need internet; buttons work offline.";
const RECOGNITION_LANG = "en-US";

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
// A science peak has no name in meta.json: its leg name is "col,row", matched to the last science plan.
function placeName(state: MissionState, id: string): string {
  const waypoint = state.meta?.waypoints.find((point) => point.id === id);
  if (waypoint) return `${id} (${waypoint.name})`;
  const peak = state.sciencePlan?.candidates.find((candidate) => candidate.kind === "peak" && `${candidate.col},${candidate.row}` === id);
  if (peak) return `${peak.id} (${PEAK_LABEL})`;
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

// ---- What the helmet shows (pure, so it can be tested without a DOM) ----

// Arrow rotation for each compass point of Route.instructions (display mapping, not a computation).
const ARROW_DEG: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SW: 225, W: 270, NW: 315 };

export type HelmetView = {
  // "step": the current instruction. "action": a contingency is active. "none": no route.
  mode: "step" | "action" | "none";
  arrowDeg: number | null;
  headline: string;
  detail: string;
  warning: string | null;
  nextStop: string;
  turnBack: { text: string; urgent: boolean };
  buddy: { text: string; warn: boolean };
  radiation: { text: string; alert: boolean };
};

export function helmetView(state: MissionState): HelmetView {
  const route = state.route;
  const crewM = route ? crewDistanceM(route, state.crewCell, state.elapsedS) : null;
  return {
    ...mainBlock(state, crewM),
    nextStop: nextStopText(state, crewM),
    turnBack: turnBackTile(state),
    buddy: buddyTile(state),
    radiation: radiationTile(state),
  };
}

type MainBlock = Pick<HelmetView, "mode" | "arrowDeg" | "headline" | "detail" | "warning">;

// A contingency comes first: its recommended action replaces the plan step.
function mainBlock(state: MissionState, crewM: number | null): MainBlock {
  const sim = state.scenario !== "none" ? state.contingency : null;
  if (sim) return actionBlock(sim);
  const route = state.route;
  if (!route || route.instructions.length === 0) {
    return { mode: "none", arrowDeg: null, headline: "No route planned", detail: "", warning: null };
  }

  // The current step: the last one that starts at or before the crew (distances from Route.elevationProfile).
  const steps = route.instructions;
  const startM = (k: number) => route.elevationProfile[steps[k].cellIndex].distanceM;
  const atM = crewM ?? 0;
  let k = 0;
  while (k + 1 < steps.length && startM(k + 1) <= atM) k++;
  const step = steps[k];
  const endM = startM(k) + step.distanceM;
  const leftM = Math.max(0, endM - atM);
  const then = k + 1 < steps.length ? `Then: ${steps[k + 1].text}` : "Then: end of the plan";
  return {
    mode: "step",
    arrowDeg: ARROW_DEG[step.direction] ?? null,
    headline: `${step.direction} ${formatDistance(leftM)}`,
    detail: `${step.text}. ${then}`,
    warning: step.warning ?? null,
  };
}

function actionBlock(sim: SimState): MainBlock {
  const target = sim.actionTargetId ?? "none reachable";
  let headline = `Go to ${target}`;
  if (sim.scenario === "sep_event") headline = `Go to shelter: ${target}`;
  if (sim.scenario === "buddy_injured") {
    const injured = sim.astronauts.find((crew) => crew.status === "injured");
    const rescuer = sim.astronauts.find((crew) => crew.status === "rescuer");
    if (injured && rescuer) headline = `${rescuer.id} carries ${injured.id} to ${target}`;
  }
  const noPath = sim.actionPath.length === 0;
  const detail = noPath ? "No walkable path" : `${formatDuration(sim.actionTimeS)}, ${formatDistance(sim.actionDistanceM)}`;
  const warning = sim.warnings.length > 0 ? sim.warnings[0] : null;
  return { mode: "action", arrowDeg: null, headline, detail, warning };
}

// Distance from the crew to the end of the current leg. Leg end distances are sums of Route.legs distances.
function nextStopText(state: MissionState, crewM: number | null): string {
  const route = state.route;
  if (!route || route.legs.length === 0) return "No route";
  const stop = nextStop(state);
  if (!stop.stopId) return "All stops done";
  let legEndM = 0;
  for (const leg of route.legs) {
    legEndM += leg.distanceM;
    const isThisLeg = leg.to === stop.stopId && crewM !== null && legEndM >= crewM - 1e-6;
    if (!isThisLeg) continue;
    const leftM = legEndM - (crewM as number);
    return leftM > 0 ? `${stop.stopId}: ${formatDistance(leftM)}` : `At ${stop.stopId}`;
  }
  return stop.stopId;
}

function turnBackTile(state: MissionState): HelmetView["turnBack"] {
  if (!state.envelope) return { text: "--", urgent: false };
  const leftS = state.envelope.turnBackAtS - state.elapsedS;
  if (leftS <= 0) return { text: "NOW", urgent: true };
  return { text: formatDuration(leftS), urgent: false };
}

function buddyTile(state: MissionState): HelmetView["buddy"] {
  if (!state.sim) return { text: "--", warn: false };
  const limitM = paramNumber(state, "BUDDY_MAX_SEPARATION_M");
  const warn = limitM !== null && state.sim.separationM > limitM;
  return { text: formatDistance(state.sim.separationM), warn };
}

function radiationTile(state: MissionState): HelmetView["radiation"] {
  if (state.scenario === "sep_event") return { text: "SOLAR PARTICLE ALERT", alert: true };
  return { text: "No alert", alert: false };
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

// Full screen is only a request: the browser may refuse it (for example inside a frame). Helmet mode works without it.
function setFullscreen(on: boolean): void {
  const active = document.fullscreenElement !== null;
  if (on && !active && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => undefined);
  if (!on && active && document.exitFullscreen) document.exitFullscreen().catch(() => undefined);
}

// The browser speech recognition API (Web Speech API). Only the parts used here; not in the TypeScript DOM types.
type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
};

function createRecognition(): Recognition | null {
  const speechWindow = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const RecognitionClass = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
  if (!RecognitionClass) return null;
  const recognition = new RecognitionClass();
  recognition.lang = RECOGNITION_LANG;
  recognition.interimResults = false;
  recognition.maxAlternatives = 1;
  return recognition;
}

// Points north (up) before rotation.
const ARROW_SVG =
  '<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 6 L88 60 L62 60 L62 94 L38 94 L38 60 L12 60 Z" fill="currentColor"/></svg>';

function scenarioDepends(state: MissionState, mode: HelmetView["mode"]): string[] {
  if (mode === "none") return [];
  if (mode === "step") return [...DEPENDS.route, ...DEPENDS.timeline];
  return state.scenario === "sep_event" ? DEPENDS.sepEvent : DEPENDS.rescue;
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

  // Main block: the big arrow and the current step, or the recommended action.
  const main = el("div", "helmet-main");
  const arrow = el("div", "helmet-arrow");
  arrow.innerHTML = ARROW_SVG;
  const mainText = el("div", "helmet-main-text");
  const headline = el("div", "helmet-headline");
  const detail = el("div", "helmet-detail");
  const warning = el("div", "helmet-warning");
  mainText.append(headline, detail, warning);
  main.append(arrow, mainText);

  const tiles = el("div", "helmet-tiles");
  const tile = (label: string) => {
    const box = el("div", "helmet-tile");
    const value = el("div", "helmet-value");
    box.append(el("div", "helmet-label", label), value);
    tiles.append(box);
    return { box, value };
  };
  const nextStopTile = tile("Next stop");
  const turnBackTile = tile("Turn back in");
  const buddyTile = tile("Buddy distance");
  const radiationTile = tile("Radiation");

  const pov = el("figure", "helmet-pov");
  const povImage = el("img");
  povImage.alt = "Curiosity image taken at the next stop";
  const povCaption = el("figcaption");
  pov.append(povImage, povCaption);

  const commands = el("div", "helmet-commands");
  const lastAnswer = el("div", "helmet-answer");
  lastAnswer.setAttribute("aria-live", "polite");
  // `heard` is the recognized phrase, shown so the crew can see what the parser got.
  const run = (intent: Intent | null, heard = ""): void => {
    const text = intent ? answer(intent, getState()).text : NOT_RECOGNIZED;
    const spoken = speak(text);
    const prefix = heard ? `Heard "${heard}". ` : "";
    lastAnswer.textContent = prefix + (spoken ? text : `${text} (Spoken answers are not available in this browser.)`);
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

  // Mic: one phrase per press, parsed by the same keyword matcher. Hidden when the browser has no speech recognition.
  const voice = el("div", "helmet-voice");
  const recognition = createRecognition();
  if (recognition) {
    const mic = el("button", "helmet-command helmet-mic", "Speak a command");
    mic.type = "button";
    let listening = false;
    mic.addEventListener("click", () => {
      if (listening) return;
      listening = true;
      mic.textContent = "Listening...";
      mic.classList.add("active");
      try {
        recognition.start();
      } catch {
        recognition.onend?.(); // already started: reset the button
      }
    });
    recognition.onresult = (event) => {
      const heard = event.results[0]?.[0]?.transcript ?? "";
      run(matchIntent(heard), heard);
    };
    recognition.onerror = (event) => {
      lastAnswer.textContent = `Speech recognition failed (${event.error}). Use the buttons.`;
    };
    recognition.onend = () => {
      listening = false;
      mic.textContent = "Speak a command";
      mic.classList.remove("active");
    };
    voice.append(mic);
  }
  voice.append(el("span", "helmet-note", recognition ? RECOGNITION_NOTE : "Speech recognition is not available in this browser; buttons work offline."));

  const body = el("div", "helmet-body");
  body.append(tiles, pov);
  root.append(head, main, body, commands, voice, lastAnswer);
  container.append(root);

  const setValue = (node: HTMLElement, text: string, depends: string[], state: MissionState): void => {
    node.replaceChildren(withTag(el("span", "", text), assumptionTag(state.meta, depends)));
  };

  const render = (state: MissionState, previous: MissionState | null): void => {
    const wasHidden = root.hidden;
    root.hidden = !state.helmet;
    const helmetChanged = previous !== null && state.helmet !== previous.helmet;
    if (helmetChanged) setFullscreen(state.helmet);
    if (!state.helmet) return;
    if (wasHidden) exit.focus();

    const view = helmetView(state);
    main.dataset.mode = view.mode;
    arrow.hidden = view.arrowDeg === null;
    if (view.arrowDeg !== null) arrow.style.transform = `rotate(${view.arrowDeg}deg)`;
    setValue(headline, view.headline, scenarioDepends(state, view.mode), state);
    detail.textContent = view.detail;
    warning.textContent = view.warning ?? "";
    warning.hidden = view.warning === null;

    setValue(nextStopTile.value, view.nextStop, [...DEPENDS.route, ...DEPENDS.timeline], state);
    setValue(turnBackTile.value, view.turnBack.text, DEPENDS.turnBack, state);
    turnBackTile.box.classList.toggle("urgent", view.turnBack.urgent);
    setValue(buddyTile.value, view.buddy.text, DEPENDS.buddy, state);
    buddyTile.box.classList.toggle("urgent", view.buddy.warn);
    const radiationDepends = state.scenario === "sep_event" ? DEPENDS.sepEvent : ["FULL_SHELTERS"];
    setValue(radiationTile.value, view.radiation.text, radiationDepends, state);
    radiationTile.box.classList.toggle("alert", view.radiation.alert);

    const stopId = nextStop(state).stopId;
    const waypoint = stopId ? state.meta?.waypoints.find((point) => point.id === stopId) : undefined;
    const hasPov = waypoint !== undefined && waypoint.pov !== null;
    pov.hidden = !hasPov;
    if (!hasPov) return;
    const src = state.siteUrl + waypoint.pov;
    if (povImage.getAttribute("src") !== src) povImage.src = src;
    povCaption.textContent = `${waypoint.id}: ${waypoint.name}. ${waypoint.povCredit ?? ""}`;
  };
  subscribe((state, previous) => render(state, previous));
  render(getState(), null);
}
