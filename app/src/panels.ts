// Left layers panel, right status panel, bottom route profile, header status.
// Panels only display store state (engine output and meta.json) and write user input to the store.
// No physics here: every number is an engine reply value, a meta.json value, or a sum or unit conversion of those.

import { type Cell, sameCell } from "./coords";
import { type MissionState, type Route, type SiteMeta, getState, removeStop, setLayerVisible, subscribe, update } from "./store";

const DASH = "--";
// DEFINITION rows of docs/assumptions.md ("Units"), plus joules per megajoule.
const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = SECONDS_PER_HOUR / SECONDS_PER_MINUTE;
const JOULES_PER_MJ = 1e6;
const METERS_PER_KM = 1000;
// Slider step: one minute of EVA time.
const TIMELINE_STEP_S = 60;

// ---- Which docs/assumptions.md constants each displayed value depends on ----
// The panel shows an "assumption" tag when any of them has status ASSUMPTION in meta.json `constants`.
const DEPENDS = {
  route: ["ROUTING_CELL_SIZE_M", "NO_CORNER_CUTTING"],
  energy: [
    "ASTRONAUT_MASS_KG",
    "SUIT_AND_GEAR_MASS_KG",
    "METABOLIC_MODEL_AT_MARS_GRAVITY",
    "SANTEE_MIN_LEVEL_FRACTION",
    "CAUTION_SLOPE_PENALTY",
    "ROUGHNESS_COST_PER_M",
    "BOULDER_COST_FACTOR",
  ],
  budget: ["EVA_ENERGY_BUDGET_J", "RESERVE_FRACTION"],
  turnBack: ["TURN_BACK_MODEL", "EVA_ENERGY_BUDGET_J", "RESERVE_FRACTION"],
  verdict: ["EVA_ENERGY_BUDGET_J", "RESERVE_FRACTION"],
  envelope: ["EVA_ENERGY_BUDGET_J", "RESERVE_FRACTION", "ASTRONAUT_MASS_KG", "SUIT_AND_GEAR_MASS_KG", "METABOLIC_MODEL_AT_MARS_GRAVITY"],
  markers: ["HABITAT_MIN_FLAT_AREA_M2", "ROVER_PICKUP_MAX_SLOPE_DEG", "ROVER_PICKUP_MIN_AREA_M2", "FULL_SHELTERS"],
  timeline: ["STOP_DWELL_MIN", "WALK_SPEED_M_PER_S"],
};

// meta.json overlays with `assumption: true` -> the pipeline constants behind them (docs/assumptions.md, "Pipeline").
const OVERLAY_DEPENDS: Record<string, string[]> = {
  boulders: ["BOULDER_LOCAL_WINDOW_M", "BOULDER_SHADOW_DARKNESS", "BOULDER_MIN_SHADOW_AREA_M2", "BOULDER_MAX_SHADOW_AREA_M2", "BOULDER_MAX_ELONGATION"],
  science: ["SCIENCE_WEIGHT_SULFATE", "SCIENCE_WEIGHT_RIDGE", "RIDGE_RADIUS_M", "SCIENCE_NORMALIZE_LOW_PERCENTILE", "SCIENCE_NORMALIZE_HIGH_PERCENTILE"],
  shield: ["TERRAIN_SHIELD_MODEL", "SHIELD_AZIMUTHS", "SHIELD_SEARCH_RADIUS_M"],
  dem_quality: ["DEM_QUALITY_COLUMN_RUN_M", "DEM_QUALITY_WINDOW_M", "DEM_QUALITY_COHERENCE_MIN", "DEM_QUALITY_MIN_AREA_M2"],
};

// ---- Small helpers ----

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function formatMJ(joules: number | null | undefined): string {
  return isNumber(joules) ? `${(joules / JOULES_PER_MJ).toFixed(2)} MJ` : DASH;
}

function formatDistance(meters: number | null | undefined): string {
  if (!isNumber(meters)) return DASH;
  if (meters < METERS_PER_KM) return `${Math.round(meters)} m`;
  return `${(meters / METERS_PER_KM).toFixed(2)} km`;
}

// "2:05" = 2 h 05 min.
function formatClock(seconds: number | null | undefined): string {
  if (!isNumber(seconds)) return DASH;
  const totalMinutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

function formatDuration(seconds: number | null | undefined): string {
  if (!isNumber(seconds)) return DASH;
  const totalMinutes = Math.round(seconds / SECONDS_PER_MINUTE);
  return `${Math.floor(totalMinutes / MINUTES_PER_HOUR)} h ${String(totalMinutes % MINUTES_PER_HOUR).padStart(2, "0")} min`;
}

// meta.json `constants` values are the text of the docs/assumptions.md Value column, for example "6 (range 4 to 8)".
// The number is the leading part. Returns null when the text does not start with a number.
export function constantNumber(meta: SiteMeta | null, name: string): number | null {
  const entry = meta?.constants[name];
  if (!entry) return null;
  const match = entry.value.trim().match(/^-?\d+(\.\d+)?(e[+-]?\d+)?/i);
  return match ? Number(match[0]) : null;
}

// A grey "assumption" tag whose tooltip names each ASSUMPTION constant in `names`, or null if none is one.
function assumptionTag(meta: SiteMeta | null, names: string[]): HTMLElement | null {
  if (!meta) return null;
  const lines: string[] = [];
  for (const name of names) {
    const entry = meta.constants[name];
    if (entry && entry.status === "ASSUMPTION") lines.push(`${name} = ${entry.value}: ${entry.source}`);
  }
  if (lines.length === 0) return null;
  const tag = el("span", "assumption-tag", "assumption");
  tag.title = `Uses ASSUMPTION constants (docs/assumptions.md):\n${lines.join("\n")}`;
  tag.tabIndex = 0;
  return tag;
}

function withTag(node: HTMLElement, tag: HTMLElement | null): HTMLElement {
  if (tag) node.append(" ", tag);
  return node;
}

function sourceTooltip(meta: SiteMeta | null, name: string): string {
  const entry = meta?.constants[name];
  return entry ? `${name} = ${entry.value} (${entry.status}): ${entry.source}` : name;
}

// A label + value row. Returns the value element so it can be updated.
function statRow(parent: HTMLElement, label: string, tag: HTMLElement | null = null): HTMLElement {
  const row = el("div", "stat-row");
  const name = withTag(el("span", "stat-label", label), tag);
  const value = el("span", "stat-value num", DASH);
  row.append(name, value);
  parent.append(row);
  return value;
}

function section(parent: HTMLElement, title: string): HTMLElement {
  const box = el("section", "panel-section");
  box.append(el("h2", "section-title", title));
  parent.append(box);
  return box;
}

const EYE_OPEN =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_CLOSED =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17.6 17.6 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6"/></svg>';

// ---- Entry point ----

export type PanelParts = { header: HTMLElement; left: HTMLElement; right: HTMLElement; profile: HTMLElement };

export function createPanels(parts: PanelParts): void {
  const header = buildHeader(parts.header);
  let left: ReturnType<typeof buildLeft> | null = null;
  let right: ReturnType<typeof buildRight> | null = null;
  const profile = buildProfile(parts.profile);

  const onState = (state: MissionState, previous: MissionState | null): void => {
    renderHeader(header, state);
    if (!state.meta) return;
    if (!left) {
      left = buildLeft(parts.left, state.meta);
      right = buildRight(parts.right, state.meta);
      previous = null;
    }
    renderLeft(left, state);
    if (right) renderRight(right, state, previous);
    renderProfile(profile, state);
  };
  subscribe(onState);
  onState(getState(), null);
}

// ---- Header: site name, engine status, offline state ----

function buildHeader(root: HTMLElement) {
  root.replaceChildren();
  const title = el("div", "app-title");
  title.append(el("span", "app-name", "Boxwork EVA Navigator"), el("span", "site-name", ""));
  const status = el("div", "engine-status");
  const dot = el("span", "status-dot");
  const text = el("span", "status-text", "loading");
  const calc = el("span", "status-calc num", "");
  status.append(dot, text, calc);
  const offline = el("span", "offline-badge", "offline: caching");
  offline.title = "The service worker stores the app and all site data, so the page works without a network after the first load.";
  root.append(title, status, offline);
  return { siteName: title.lastElementChild as HTMLElement, status, text, calc, offline };
}

function renderHeader(refs: ReturnType<typeof buildHeader>, state: MissionState): void {
  refs.siteName.textContent = state.meta ? state.meta.name : "";
  refs.status.dataset.status = state.engine.status;
  const labels = { loading: "loading site", ready: "engine ready", calculating: "calculating", error: "engine error" };
  refs.text.textContent = labels[state.engine.status];
  refs.status.title = state.engine.error ?? "";
  const calc = state.engine.lastCalc;
  refs.calc.textContent = calc ? `last ${calc.request} ${Math.round(calc.ms)} ms` : "";
  refs.offline.textContent = state.offlineReady ? "offline ready" : "offline: caching";
  refs.offline.classList.toggle("ready", state.offlineReady);
  // Dev server has no service worker: hide the badge instead of showing a state that never changes.
  refs.offline.hidden = import.meta.env.DEV;
}

// ---- Left: data layers ----

type LayerRow = { id: string; button: HTMLButtonElement };

function buildLeft(root: HTMLElement, meta: SiteMeta) {
  root.replaceChildren();
  const box = section(root, "Data layers");
  const rows: LayerRow[] = [];

  const addRow = (id: string, label: string, source: string, description: string, tag: HTMLElement | null): void => {
    const row = el("div", "layer-row");
    const button = el("button", "eye-toggle");
    button.type = "button";
    button.setAttribute("aria-label", `Show ${label}`);
    button.addEventListener("click", () => setLayerVisible(id, !getState().layers[id]));
    const text = el("div", "layer-text");
    const name = withTag(el("div", "layer-name", label), tag);
    name.title = description;
    text.append(name, el("div", "layer-source", source));
    row.append(button, text);
    box.append(row);
    rows.push({ id, button });
  };

  addRow("basemap", "HiRISE orthophoto", meta.tiles.source, "Color orthophoto mosaic, 0.5 m pixels at full zoom.", null);
  for (const overlay of meta.overlays) {
    let tag: HTMLElement | null = null;
    if (overlay.assumption) {
      tag = assumptionTag(meta, OVERLAY_DEPENDS[overlay.id] ?? []);
      if (!tag) {
        tag = el("span", "assumption-tag", "assumption");
        tag.title = overlay.description;
      }
    }
    addRow(overlay.id, overlay.label, overlay.source, overlay.description, tag);
  }
  addRow(
    "envelope",
    "Walk-back area",
    "Engine: reversed-edge Dijkstra from the habitat",
    "Green: can return to the habitat and keep the reserve. Amber: can return only by using the reserve. Clear: cannot return in time or energy.",
    assumptionTag(meta, DEPENDS.envelope),
  );
  addRow("route", "Route", "Engine: directional energy A*", "Minimum-energy route through the stops, and the return path from the crew position.", assumptionTag(meta, DEPENDS.energy));
  addRow("markers", "Site points and plan", "Pipeline rules; NASA/JPL-Caltech (Curiosity stops)", "Habitat, rover, pickup zones, Curiosity stops, your start, end and stops.", assumptionTag(meta, DEPENDS.markers));

  const legend = el("div", "legend");
  legend.innerHTML = `
    <div class="legend-row"><span class="swatch swatch-safe"></span>Safe return, reserve kept</div>
    <div class="legend-row"><span class="swatch swatch-reserve"></span>Return only with the reserve</div>
    <div class="legend-row"><span class="swatch swatch-route"></span>Planned route</div>
    <div class="legend-row"><span class="swatch swatch-return"></span>Return path from crew</div>`;
  box.append(legend);
  return { rows };
}

function renderLeft(refs: ReturnType<typeof buildLeft>, state: MissionState): void {
  for (const row of refs.rows) {
    const visible = state.layers[row.id] === true;
    row.button.innerHTML = visible ? EYE_OPEN : EYE_CLOSED;
    row.button.classList.toggle("on", visible);
    row.button.setAttribute("aria-pressed", String(visible));
  }
}

// ---- Right: plan, timeline, energy, route summary, contingencies ----

function buildRight(root: HTMLElement, meta: SiteMeta) {
  root.replaceChildren();

  // Plan
  const plan = section(root, "Plan");
  const hint = el("div", "hint");
  const buttons = el("div", "button-row");
  const makeButton = (label: string, onClick: () => void): HTMLButtonElement => {
    const button = el("button", "btn", label);
    button.type = "button";
    button.addEventListener("click", onClick);
    buttons.append(button);
    return button;
  };
  const setStart = makeButton("Set start", () => update({ placing: getState().placing === "start" ? "stop" : "start" }));
  const setEnd = makeButton("Set end", () => update({ placing: getState().placing === "end" ? "stop" : "end" }));
  makeButton("Start and end at habitat", () => update({ start: null, end: null, placing: "stop" }));
  makeButton("Clear stops", () => update({ stops: [], selectedStop: null }));
  const startEnd = el("div", "start-end num");
  const stopList = el("ol", "stop-list");
  plan.append(hint, buttons, startEnd, stopList);

  // Timeline
  const timeline = section(root, "EVA timeline");
  const evaHours = constantNumber(meta, "EVA_DURATION_H");
  const sliderRow = el("div", "slider-head");
  const elapsed = el("span", "big-number num", DASH);
  const total = el("span", "slider-total num", evaHours === null ? `/ ${DASH}` : `/ ${formatClock(evaHours * SECONDS_PER_HOUR)}`);
  total.title = sourceTooltip(meta, "EVA_DURATION_H");
  sliderRow.append(elapsed, total);
  const slider = el("input", "timeline-slider");
  slider.type = "range";
  slider.min = "0";
  slider.step = String(TIMELINE_STEP_S);
  slider.max = evaHours === null ? "0" : String(evaHours * SECONDS_PER_HOUR);
  slider.disabled = evaHours === null;
  slider.setAttribute("aria-label", "Elapsed EVA time");
  slider.addEventListener("input", () => update({ elapsedS: Number(slider.value) }));
  timeline.append(sliderRow, slider);
  const turnBack = statRow(timeline, "Turn back by", assumptionTag(meta, DEPENDS.turnBack));
  const crewAt = statRow(timeline, "Crew A position", assumptionTag(meta, DEPENDS.timeline));
  const timelineNote = el("div", "note");
  timeline.append(timelineNote);

  // Energy budget
  const energy = section(root, "Energy budget");
  const budgetHead = withTag(el("div", "budget-head", "Used | remaining | reserve (hatched) | plan total (tick)"), assumptionTag(meta, DEPENDS.budget));
  const bar = el("div", "budget-bar");
  const reserve = el("div", "budget-reserve");
  const used = el("div", "budget-used");
  const planTick = el("div", "budget-plan");
  bar.append(reserve, used, planTick);
  energy.append(budgetHead, bar);
  const usedValue = statRow(energy, "Used");
  const remainingValue = statRow(energy, "Remaining");
  const reserveValue = statRow(energy, "Reserve section");
  const budgetValue = statRow(energy, "EVA budget", assumptionTag(meta, DEPENDS.budget));

  // Route summary
  const summary = section(root, "Route");
  const verdict = el("div", "verdict");
  verdict.title = "Rules: docs/assumptions.md, section Engine";
  summary.append(verdict);
  const distance = statRow(summary, "Distance", assumptionTag(meta, DEPENDS.route));
  const time = statRow(summary, "Time (walking + stops)");
  const stopTime = statRow(summary, "Time at stops");
  stopTime.title = sourceTooltip(meta, "STOP_DWELL_MIN");
  const routeEnergy = statRow(summary, "Energy", assumptionTag(meta, DEPENDS.energy));
  const gain = statRow(summary, "Elevation gain");
  const reasons = el("ul", "reasons");
  summary.append(reasons);

  // Phase 4 placeholders: no logic yet.
  const next = section(root, "Contingencies");
  const nextRow = el("div", "button-row");
  for (const label of ["Simulate solar particle event", "Simulate buddy injured", "Helmet mode"]) {
    const button = el("button", "btn", label);
    button.type = "button";
    button.disabled = true;
    nextRow.append(button);
  }
  next.append(nextRow, el("div", "coming-next", "coming next"));

  return {
    meta,
    hint,
    setStart,
    setEnd,
    startEnd,
    stopList,
    elapsed,
    slider,
    turnBack,
    crewAt,
    timelineNote,
    reserve,
    used,
    planTick,
    usedValue,
    remainingValue,
    reserveValue,
    budgetValue,
    verdict,
    distance,
    time,
    stopTime,
    routeEnergy,
    gain,
    reasons,
  };
}

function cellLabel(meta: SiteMeta, cell: Cell | null, fallback: string): string {
  if (!cell) return fallback;
  const waypoint = meta.waypoints.find((point) => sameCell(point, cell));
  if (waypoint) return `${waypoint.id} (${waypoint.name})`;
  if (sameCell(meta.habitat, cell)) return "habitat";
  return `cell ${cell.col},${cell.row}`;
}

function renderRight(refs: ReturnType<typeof buildRight>, state: MissionState, previous: MissionState | null): void {
  const changed = (key: keyof MissionState): boolean => previous === null || state[key] !== previous[key];
  const meta = refs.meta;

  if (changed("placing")) {
    const hints = {
      stop: "Click the map or a Curiosity stop to add a stop. Drag a stop to move it, right-click to delete.",
      start: "Click the map to set the start.",
      end: "Click the map to set the end.",
    };
    refs.hint.textContent = hints[state.placing];
    refs.hint.classList.toggle("active", state.placing !== "stop");
    refs.setStart.classList.toggle("active", state.placing === "start");
    refs.setEnd.classList.toggle("active", state.placing === "end");
  }

  if (changed("start") || changed("end")) {
    refs.startEnd.textContent = `Start: ${cellLabel(meta, state.start, "habitat")}  |  End: ${cellLabel(meta, state.end, "habitat")}`;
  }

  if (changed("stops") || changed("selectedStop")) {
    refs.stopList.replaceChildren();
    state.stops.forEach((stop, index) => {
      const item = el("li", state.selectedStop === index ? "selected" : "");
      const label = el("button", "stop-label", `${index + 1}. ${cellLabel(meta, stop, "")}`);
      label.type = "button";
      label.addEventListener("click", () => update({ selectedStop: index }));
      const remove = el("button", "stop-remove", "x");
      remove.type = "button";
      remove.setAttribute("aria-label", `Delete stop ${index + 1}`);
      remove.addEventListener("click", () => removeStop(index));
      item.append(label, remove);
      refs.stopList.append(item);
    });
    if (state.stops.length === 0) refs.stopList.append(el("li", "empty", "No stops yet"));
  }

  // Timeline. Do not move the slider under the user's pointer.
  if (changed("elapsedS")) {
    refs.elapsed.textContent = formatClock(state.elapsedS);
    if (document.activeElement !== refs.slider) refs.slider.value = String(state.elapsedS);
  }
  if (changed("envelope") || changed("crewCell") || changed("sim") || changed("timelineError")) {
    const turnBackS = state.envelope ? state.envelope.turnBackAtS : null;
    refs.turnBack.textContent = formatClock(turnBackS);
    const mustReturn = isNumber(turnBackS) && state.elapsedS >= turnBackS;
    refs.turnBack.classList.toggle("warn", mustReturn);
    refs.crewAt.textContent = cellLabel(meta, state.crewCell, DASH);
    const lines: string[] = [];
    if (state.timelineError) lines.push(`Walk-back area not available: ${state.timelineError}`);
    if (state.sim) lines.push(...state.sim.warnings);
    if (mustReturn) lines.push("Past the turn-back time: return to the habitat now.");
    refs.timelineNote.textContent = lines.join(" ");
  }

  // Energy budget. Budget = remaining + used, both from the same engine reply.
  if (changed("envelope") || changed("usedJ") || changed("route")) {
    const remainingJ = state.envelope ? state.envelope.remainingJ : null;
    const usedJ = state.usedJ;
    const budgetJ = isNumber(remainingJ) && isNumber(usedJ) ? remainingJ + usedJ : null;
    const reserveFraction = constantNumber(meta, "RESERVE_FRACTION");
    const reserveJ = isNumber(budgetJ) && isNumber(reserveFraction) ? budgetJ * reserveFraction : null;

    refs.usedValue.textContent = formatMJ(usedJ);
    refs.remainingValue.textContent = formatMJ(remainingJ);
    refs.reserveValue.textContent = formatMJ(reserveJ);
    refs.budgetValue.textContent = formatMJ(budgetJ);

    const share = (joules: number | null): number => (isNumber(joules) && isNumber(budgetJ) && budgetJ > 0 ? Math.min(1, Math.max(0, joules / budgetJ)) : 0);
    refs.used.style.width = `${share(usedJ) * 100}%`;
    const reserveShare = share(reserveJ);
    refs.reserve.style.left = `${(1 - reserveShare) * 100}%`;
    refs.reserve.style.width = `${reserveShare * 100}%`;
    const planJ = state.route ? state.route.totalEnergyJ : null;
    refs.planTick.hidden = !isNumber(planJ) || !isNumber(budgetJ);
    refs.planTick.style.left = `${share(planJ) * 100}%`;
    refs.planTick.title = `Planned route total ${formatMJ(planJ)}`;
    const usingReserve = isNumber(usedJ) && isNumber(budgetJ) && isNumber(reserveJ) && usedJ > budgetJ - reserveJ;
    refs.used.classList.toggle("in-reserve", usingReserve);
  }

  if (changed("route") || changed("routeError")) renderRouteSummary(refs, state.route, state.routeError);
}

function renderRouteSummary(refs: ReturnType<typeof buildRight>, route: Route | null, routeError: string | null): void {
  refs.verdict.replaceChildren();
  refs.reasons.replaceChildren();
  if (!route) {
    refs.verdict.dataset.verdict = "none";
    refs.verdict.append(el("span", "verdict-badge", DASH));
    for (const value of [refs.distance, refs.time, refs.stopTime, refs.routeEnergy, refs.gain]) value.textContent = DASH;
    if (routeError) refs.reasons.append(el("li", "", routeError));
    return;
  }

  refs.verdict.dataset.verdict = route.verdict;
  const badgeText = { GO: "GO", CAUTION: "CAUTION", NO_GO: "NO GO" };
  refs.verdict.append(el("span", "verdict-badge", badgeText[route.verdict]));
  const tag = assumptionTag(refs.meta, DEPENDS.verdict);
  if (tag) refs.verdict.append(tag);

  const distanceM = route.legs.reduce((sum, leg) => sum + leg.distanceM, 0);
  refs.distance.textContent = route.legs.length > 0 ? formatDistance(distanceM) : DASH;
  refs.time.textContent = formatDuration(route.totalTimeS);
  refs.stopTime.textContent = formatDuration(route.stopTimeS);
  refs.routeEnergy.textContent = formatMJ(route.totalEnergyJ);
  refs.gain.textContent = route.elevationProfile.length > 1 ? `${Math.round(elevationGainM(route, refs.meta.noData))} m` : DASH;

  for (const reason of route.reasons) refs.reasons.append(el("li", "", reason));
  if (route.reasons.length === 0) refs.reasons.append(el("li", "ok", "No limit is reached."));
}

// Sum of the climbs along the engine's elevation profile.
function elevationGainM(route: Route, noData: number): number {
  let gain = 0;
  const profile = route.elevationProfile;
  for (let i = 1; i < profile.length; i++) {
    const a = profile[i - 1].elevationM;
    const b = profile[i].elevationM;
    if (a === noData || b === noData) continue;
    if (b > a) gain += b - a;
  }
  return gain;
}

// ---- Bottom: route profile ----
// Two small charts on one shared distance axis (never two y-axes on one chart):
// elevation per route cell, and cumulative energy. The engine gives energy per leg only, so the energy chart has
// points at the start, at each stop (arrival and departure: the rise during the stop is STOP_DWELL_MIN at STATION_WORK_W)
// and at the end, joined by straight lines.

const SVG_NS = "http://www.w3.org/2000/svg";
const CHART_MARGIN = { left: 64, right: 18, top: 22, bottom: 8 };
const AXIS_HEIGHT = 22;

type ProfileRefs = { root: HTMLElement; svg: SVGSVGElement; tooltip: HTMLElement; empty: HTMLElement; state: MissionState | null };

function buildProfile(root: HTMLElement): ProfileRefs {
  root.replaceChildren();
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "profile-svg");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Route elevation and cumulative energy along the route distance");
  const tooltip = el("div", "profile-tooltip");
  tooltip.hidden = true;
  const empty = el("div", "profile-empty", "Add stops to see the route profile.");
  root.append(svg, tooltip, empty);
  const refs: ProfileRefs = { root, svg, tooltip, empty, state: null };
  new ResizeObserver(() => {
    if (refs.state) drawProfile(refs, refs.state);
  }).observe(root);
  return refs;
}

function renderProfile(refs: ProfileRefs, state: MissionState): void {
  const previous = refs.state;
  refs.state = state;
  const unchanged = previous !== null && previous.route === state.route && previous.crewCell === state.crewCell && previous.envelope === state.envelope;
  if (unchanged) return;
  drawProfile(refs, state);
}

type EnergyPoint = { distanceM: number; energyJ: number };

function energyPoints(route: Route): EnergyPoint[] {
  const points: EnergyPoint[] = [{ distanceM: 0, energyJ: 0 }];
  const stopCount = route.legs.length - 1;
  const stopEnergyEachJ = stopCount > 0 ? route.stopEnergyJ / stopCount : 0;
  let distanceM = 0;
  let energyJ = 0;
  route.legs.forEach((leg, i) => {
    distanceM += leg.distanceM;
    energyJ += leg.energyJ;
    points.push({ distanceM, energyJ });
    const isStop = i < route.legs.length - 1;
    if (isStop) {
      energyJ += stopEnergyEachJ;
      points.push({ distanceM, energyJ });
    }
  });
  return points;
}

// Distance along the route of the crew cell from the simulate reply.
// A route can pass the same cell twice (out and back). The leg the crew is on follows from the leg times plus the
// dwell at each stop (engine values), and the match inside that leg's distance range is taken.
function crewDistanceM(route: Route, crewCell: Cell | null, elapsedS: number): number | null {
  if (!crewCell || route.path.length === 0) return null;
  const matches: number[] = [];
  route.path.forEach((cell, i) => {
    if (sameCell(cell, crewCell)) matches.push(i);
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) return route.elevationProfile[matches[0]].distanceM;

  const stopCount = route.legs.length - 1;
  const dwellEachS = stopCount > 0 ? route.stopTimeS / stopCount : 0;
  let legStartS = 0;
  let legStartM = 0;
  for (let i = 0; i < route.legs.length; i++) {
    const leg = route.legs[i];
    const legEndM = legStartM + leg.distanceM;
    const nextLegStartS = legStartS + leg.timeS + dwellEachS;
    const onThisLeg = elapsedS < nextLegStartS || i === route.legs.length - 1;
    if (onThisLeg) {
      const inLeg = matches.find((index) => {
        const d = route.elevationProfile[index].distanceM;
        return d >= legStartM - 1e-6 && d <= legEndM + 1e-6;
      });
      return route.elevationProfile[inLeg ?? matches[0]].distanceM;
    }
    legStartS = nextLegStartS;
    legStartM = legEndM;
  }
  return route.elevationProfile[matches[0]].distanceM;
}

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const rough = span / count;
  const power = Math.pow(10, Math.floor(Math.log10(rough)));
  const steps = [1, 2, 5, 10];
  const step = power * (steps.find((s) => s * power >= rough) ?? 10);
  const ticks: number[] = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) ticks.push(value);
  return ticks;
}

function svgNode(tag: string, attrs: Record<string, string | number>, text = ""): SVGElement {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  if (text) node.textContent = text;
  return node;
}

function drawProfile(refs: ProfileRefs, state: MissionState): void {
  const svg = refs.svg;
  svg.replaceChildren();
  refs.tooltip.hidden = true;
  const route = state.route;
  const hasRoute = route !== null && route.elevationProfile.length > 1 && route.legs.length > 0;
  refs.empty.hidden = hasRoute;
  if (!route || !hasRoute) return;

  const width = refs.root.clientWidth;
  const height = refs.root.clientHeight;
  if (width < 100 || height < 80) return;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));

  const meta = state.meta;
  const noData = meta ? meta.noData : null;
  const profile = route.elevationProfile.filter((point) => point.elevationM !== noData);
  const energy = energyPoints(route);
  const totalM = route.elevationProfile[route.elevationProfile.length - 1].distanceM;

  const plotLeft = CHART_MARGIN.left;
  const plotRight = width - CHART_MARGIN.right;
  const chartHeight = (height - AXIS_HEIGHT) / 2;
  const x = (distanceM: number): number => plotLeft + (totalM > 0 ? (distanceM / totalM) * (plotRight - plotLeft) : 0);

  // Elevation chart (top)
  const elevTop = CHART_MARGIN.top;
  const elevBottom = chartHeight - CHART_MARGIN.bottom;
  const elevations = profile.map((point) => point.elevationM);
  let elevMin = Math.min(...elevations);
  let elevMax = Math.max(...elevations);
  const elevPad = Math.max(2, (elevMax - elevMin) * 0.1);
  elevMin -= elevPad;
  elevMax += elevPad;
  const yElev = (m: number): number => elevBottom - ((m - elevMin) / (elevMax - elevMin)) * (elevBottom - elevTop);

  // Energy chart (bottom). The scale includes the EVA budget so the margin to it is visible.
  const energyTop = chartHeight + CHART_MARGIN.top;
  const energyBottom = 2 * chartHeight - CHART_MARGIN.bottom;
  const budgetJ = state.envelope && isNumber(state.usedJ) ? state.envelope.remainingJ + state.usedJ : null;
  const reserveFraction = constantNumber(meta, "RESERVE_FRACTION");
  const energyMax = Math.max(route.totalEnergyJ, budgetJ ?? 0) * 1.05 || 1;
  const yEnergy = (j: number): number => energyBottom - (j / energyMax) * (energyBottom - energyTop);

  const grid = svgNode("g", { class: "chart-grid" });
  const axes = svgNode("g", { class: "chart-axis" });
  svg.append(grid, axes);

  // Titles
  axes.append(svgNode("text", { x: plotLeft, y: elevTop - 8, class: "chart-title" }, "Elevation (m, areoid)"));
  axes.append(svgNode("text", { x: plotLeft, y: energyTop - 8, class: "chart-title" }, "Cumulative energy (MJ), points at stops"));

  // Y gridlines and labels
  for (const tick of niceTicks(elevMin, elevMax, 3)) {
    grid.append(svgNode("line", { x1: plotLeft, x2: plotRight, y1: yElev(tick), y2: yElev(tick) }));
    axes.append(svgNode("text", { x: plotLeft - 8, y: yElev(tick) + 4, class: "tick-y" }, String(Math.round(tick))));
  }
  for (const tick of niceTicks(0, energyMax / JOULES_PER_MJ, 3)) {
    const y = yEnergy(tick * JOULES_PER_MJ);
    grid.append(svgNode("line", { x1: plotLeft, x2: plotRight, y1: y, y2: y }));
    axes.append(svgNode("text", { x: plotLeft - 8, y: y + 4, class: "tick-y" }, tick.toFixed(tick < 10 ? 1 : 0)));
  }

  // Shared distance axis at the bottom
  const axisY = 2 * chartHeight + 14;
  for (const tick of niceTicks(0, totalM, 6)) {
    const label = totalM >= METERS_PER_KM ? `${(tick / METERS_PER_KM).toFixed(tick % METERS_PER_KM === 0 ? 0 : 1)} km` : `${Math.round(tick)} m`;
    axes.append(svgNode("text", { x: x(tick), y: axisY, class: "tick-x" }, label));
  }

  // Stop guides: vertical lines at the end of each leg except the last, with the stop number.
  let legEndM = 0;
  route.legs.slice(0, -1).forEach((leg, i) => {
    legEndM += leg.distanceM;
    grid.append(svgNode("line", { x1: x(legEndM), x2: x(legEndM), y1: elevTop, y2: energyBottom, class: "stop-guide" }));
    // Inside the plot top, so the number never collides with the chart title above the plot.
    axes.append(svgNode("text", { x: x(legEndM), y: elevTop + 10, class: "stop-number" }, String(i + 1)));
  });

  // Elevation area + line
  const elevLine = profile.map((p) => `${x(p.distanceM).toFixed(1)},${yElev(p.elevationM).toFixed(1)}`).join(" ");
  const first = profile[0];
  const last = profile[profile.length - 1];
  svg.append(
    svgNode("polygon", {
      class: "elev-area",
      points: `${x(first.distanceM)},${elevBottom} ${elevLine} ${x(last.distanceM)},${elevBottom}`,
    }),
  );
  svg.append(svgNode("polyline", { class: "elev-line", points: elevLine }));

  // Budget and reserve limit lines, labeled directly
  if (isNumber(budgetJ)) {
    svg.append(svgNode("line", { class: "limit-line", x1: plotLeft, x2: plotRight, y1: yEnergy(budgetJ), y2: yEnergy(budgetJ) }));
    svg.append(svgNode("text", { class: "limit-label", x: plotRight - 4, y: yEnergy(budgetJ) - 4 }, "EVA budget"));
    if (isNumber(reserveFraction)) {
      const limitJ = budgetJ * (1 - reserveFraction);
      svg.append(svgNode("line", { class: "limit-line reserve", x1: plotLeft, x2: plotRight, y1: yEnergy(limitJ), y2: yEnergy(limitJ) }));
      // Below its line: the budget label sits above the budget line, and the two lines are close.
      svg.append(svgNode("text", { class: "limit-label", x: plotRight - 4, y: yEnergy(limitJ) + 12 }, "Reserve starts"));
    }
  }

  // Energy line + points
  svg.append(svgNode("polyline", { class: "energy-line", points: energy.map((p) => `${x(p.distanceM).toFixed(1)},${yEnergy(p.energyJ).toFixed(1)}`).join(" ") }));
  for (const point of energy) {
    const dot = svgNode("circle", { class: "energy-dot", cx: x(point.distanceM), cy: yEnergy(point.energyJ), r: 4 });
    svg.append(dot);
  }

  // Current timeline position
  const crewM = crewDistanceM(route, state.crewCell, state.elapsedS);
  if (crewM !== null) {
    svg.append(svgNode("line", { class: "crew-line", x1: x(crewM), x2: x(crewM), y1: elevTop, y2: energyBottom }));
    const crewPoint = route.elevationProfile.find((p) => p.distanceM >= crewM);
    if (crewPoint) svg.append(svgNode("circle", { class: "crew-dot", cx: x(crewM), cy: yElev(crewPoint.elevationM), r: 5 }));
    // Label on the side with room, so it is not cut off at the right edge.
    const labelOnLeft = x(crewM) > plotRight - 60;
    const labelX = labelOnLeft ? x(crewM) - 6 : x(crewM) + 6;
    svg.append(svgNode("text", { class: "crew-label", x: labelX, y: energyBottom - 4, "text-anchor": labelOnLeft ? "end" : "start" }, "crew A"));
  }

  // Hover: crosshair across both charts + tooltip with the nearest profile point.
  const crosshair = svgNode("line", { class: "crosshair", x1: 0, x2: 0, y1: elevTop, y2: energyBottom, visibility: "hidden" });
  const hit = svgNode("rect", { class: "hit-area", x: plotLeft, y: elevTop, width: plotRight - plotLeft, height: energyBottom - elevTop });
  svg.append(crosshair, hit);
  hit.addEventListener("mousemove", (event) => {
    const box = svg.getBoundingClientRect();
    const px = (event as MouseEvent).clientX - box.left;
    const distanceM = ((px - plotLeft) / (plotRight - plotLeft)) * totalM;
    const nearest = nearestProfilePoint(profile, distanceM);
    if (!nearest) return;
    const energyBefore = [...energy].reverse().find((p) => p.distanceM <= nearest.distanceM + 1e-6);
    crosshair.setAttribute("x1", String(x(nearest.distanceM)));
    crosshair.setAttribute("x2", String(x(nearest.distanceM)));
    crosshair.setAttribute("visibility", "visible");
    refs.tooltip.hidden = false;
    refs.tooltip.innerHTML = `<div class="num">${formatDistance(nearest.distanceM)}</div>
      <div>Elevation <span class="num">${nearest.elevationM.toFixed(1)} m</span></div>
      <div>Energy at last point <span class="num">${formatMJ(energyBefore ? energyBefore.energyJ : null)}</span></div>`;
    const tipLeft = Math.min(x(nearest.distanceM) + 12, width - refs.tooltip.offsetWidth - 4);
    refs.tooltip.style.left = `${tipLeft}px`;
    refs.tooltip.style.top = `${elevTop}px`;
  });
  hit.addEventListener("mouseleave", () => {
    crosshair.setAttribute("visibility", "hidden");
    refs.tooltip.hidden = true;
  });
}

function nearestProfilePoint(profile: Route["elevationProfile"], distanceM: number): Route["elevationProfile"][number] | null {
  let best: Route["elevationProfile"][number] | null = null;
  let bestGap = Infinity;
  for (const point of profile) {
    const gap = Math.abs(point.distanceM - distanceM);
    if (gap < bestGap) {
      bestGap = gap;
      best = point;
    }
  }
  return best;
}
