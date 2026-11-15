// Left layers panel, right status panel, bottom route profile, header status.
// Panels only display store state (engine output and meta.json) and write user input to the store.
// No physics here: every number is an engine reply value, a meta.json value, or a sum or unit conversion of those.

import { type Cell, sameCell } from "./coords";
import {
  type MissionState,
  type Route,
  type Scenario,
  type SciencePlan,
  type SimState,
  type SiteMeta,
  getState,
  paramNumber,
  removeStop,
  setLayerVisible,
  subscribe,
  update,
} from "./store";

const DASH = "--";
const AUTO_PLAN_LABEL = "Auto-plan stops";
export const PEAK_LABEL = "science peak, no Curiosity image";
// DEFINITION rows of docs/assumptions.md ("Units").
export const SECONDS_PER_HOUR = 3600;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = SECONDS_PER_HOUR / SECONDS_PER_MINUTE;
export const JOULES_PER_MJ = 1e6;
const METERS_PER_KM = 1000;
// docs/assumptions.md, "App display".
const TIMELINE_STEP_S = 60;
// docs/assumptions.md, "Units": the uint8 science value scale (docs/data-contract.md, section 1).
const SCIENCE_VALUE_MAX = 255;

// ---- Which docs/assumptions.md constants each displayed value depends on ----
// The panel shows an "assumption" tag when any of them has status ASSUMPTION in meta.json `constants`.

// meta.json overlays with `assumption: true` -> the pipeline constants behind them (docs/assumptions.md, "Pipeline").
export const OVERLAY_DEPENDS: Record<string, string[]> = {
  slope: ["ROUTING_CELL_SIZE_M", "CAUTION_SLOPE_PENALTY"],
  boulders: ["BOULDER_LOCAL_WINDOW_M", "BOULDER_SHADOW_DARKNESS", "BOULDER_MIN_SHADOW_AREA_M2", "BOULDER_MAX_SHADOW_AREA_M2", "BOULDER_MAX_ELONGATION"],
  science: ["SCIENCE_WEIGHT_SULFATE", "SCIENCE_WEIGHT_RIDGE", "RIDGE_RADIUS_M", "SCIENCE_NORMALIZE_LOW_PERCENTILE", "SCIENCE_NORMALIZE_HIGH_PERCENTILE"],
  shield: ["TERRAIN_SHIELD_MODEL", "SHIELD_AZIMUTHS", "SHIELD_SEARCH_RADIUS_M"],
  dem_quality: ["DEM_QUALITY_COLUMN_RUN_M", "DEM_QUALITY_WINDOW_M", "DEM_QUALITY_COHERENCE_MIN", "DEM_QUALITY_MIN_AREA_M2"],
};

// The route is the minimum-energy path on the 3 m grid, so its geometry depends on the energy model too.
const ROUTE = ["ROUTING_CELL_SIZE_M", "NO_CORNER_CUTTING"];
const ENERGY = [
  "ASTRONAUT_MASS_KG",
  "SUIT_AND_GEAR_MASS_KG",
  "METABOLIC_MODEL_AT_MARS_GRAVITY",
  "SANTEE_MIN_LEVEL_FRACTION",
  "CAUTION_SLOPE_PENALTY",
  "ROUGHNESS_COST_PER_M",
  "BOULDER_COST_FACTOR",
];
const BUDGET = ["EVA_ENERGY_BUDGET_J", "RESERVE_FRACTION"];

export const DEPENDS = {
  route: ROUTE,
  energy: ENERGY,
  budget: BUDGET,
  // Route totals measured along the route: distance, time, elevation gain.
  routeTotals: [...ROUTE, ...ENERGY],
  turnBack: ["TURN_BACK_MODEL", ...BUDGET],
  // CAUTION and NO_GO come from energy, the reserve, and low-confidence DEM cells (docs/assumptions.md, "Engine").
  verdict: [...BUDGET, ...ENERGY, ...OVERLAY_DEPENDS.dem_quality],
  envelope: [...BUDGET, "ASTRONAUT_MASS_KG", "SUIT_AND_GEAR_MASS_KG", "METABOLIC_MODEL_AT_MARS_GRAVITY"],
  markers: [
    "HABITAT_MIN_FLAT_AREA_M2",
    "ROVER_PICKUP_MAX_SLOPE_DEG",
    "ROVER_PICKUP_MIN_AREA_M2",
    "ROVER_PICKUP_MAX_COUNT",
    "ROVER_PICKUP_MIN_SPACING_M",
    "SCIENCE_STOP_COUNT",
    "SCIENCE_STOP_MIN_SPACING_M",
    "FULL_SHELTERS",
  ],
  // Crew position along the route: walking pace and stop time along the minimum-energy route.
  timeline: ["STOP_DWELL_MIN", "WALK_SPEED_M_PER_S", ...ROUTE, ...ENERGY],
  buddy: ["BUDDY_MAX_SEPARATION_M"],
  sepEvent: ["SEP_SHELTER_TARGET_MIN", "FULL_SHELTERS"],
  partialShelter: ["SHIELD_PARTIAL_MAX_SKY", "TERRAIN_SHIELD_MODEL"],
  rescue: ["RESCUE_SPEED_M_PER_S", "ASTRONAUT_MASS_KG", "SUIT_AND_GEAR_MASS_KG", "METABOLIC_MODEL_AT_MARS_GRAVITY", "EVA_ENERGY_BUDGET_J"],
  // Planner limits (docs/data-contract.md, 4.1) and the waypoint science value it maximizes.
  science: [...BUDGET, ...OVERLAY_DEPENDS.science, "SCIENCE_PEAK_COUNT", "SCIENCE_STOP_MIN_SPACING_M"],
};

// ---- Small helpers ----

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function formatMJ(joules: number | null | undefined): string {
  return isNumber(joules) ? `${(joules / JOULES_PER_MJ).toFixed(2)} MJ` : DASH;
}

export function formatDistance(meters: number | null | undefined): string {
  if (!isNumber(meters)) return DASH;
  if (meters < METERS_PER_KM) return `${Math.round(meters)} m`;
  return `${(meters / METERS_PER_KM).toFixed(2)} km`;
}

// "2:05" = 2 h 05 min.
export function formatClock(seconds: number | null | undefined): string {
  if (!isNumber(seconds)) return DASH;
  const totalMinutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  return `${hours}:${String(minutes).padStart(2, "0")}`;
}

export function formatDuration(seconds: number | null | undefined): string {
  if (!isNumber(seconds)) return DASH;
  const totalMinutes = Math.round(seconds / SECONDS_PER_MINUTE);
  return `${Math.floor(totalMinutes / MINUTES_PER_HOUR)} h ${String(totalMinutes % MINUTES_PER_HOUR).padStart(2, "0")} min`;
}


// Text and tooltip of an "assumption" tag, or null when none of `names` is an ASSUMPTION constant.
// `params` are the user's settings (About page). A changed constant shows its current value next to the documented one,
// so the tag never describes a value the engine is no longer using.
export function tagDescription(
  meta: SiteMeta | null,
  names: string[],
  params: Record<string, number | null>,
): { text: string; title: string; changed: boolean } | null {
  if (!meta) return null;
  const lines: string[] = [];
  let changed = false;
  for (const name of names) {
    const entry = meta.constants[name];
    if (!entry || entry.status !== "ASSUMPTION") continue;
    const setting = params[name];
    const isChanged = typeof setting === "number";
    if (isChanged) changed = true;
    const value = isChanged ? `${setting} (your setting; docs: ${entry.value})` : entry.value;
    lines.push(`${name} = ${value}: ${entry.source}`);
  }
  if (lines.length === 0) return null;
  const heading = changed
    ? "Uses ASSUMPTION constants, some changed in Settings (docs/assumptions.md):"
    : "Uses ASSUMPTION constants (docs/assumptions.md):";
  return { text: changed ? "assumption, changed" : "assumption", title: `${heading}\n${lines.join("\n")}`, changed };
}

function describeTag(tag: HTMLElement, meta: SiteMeta | null, params: Record<string, number | null>): void {
  const names = (tag.dataset.constants ?? "").split(",").filter((name) => name !== "");
  const description = tagDescription(meta, names, params);
  if (!description) return;
  tag.textContent = description.text;
  tag.title = description.title;
  tag.classList.toggle("is-changed", description.changed);
}

// A grey "assumption" tag whose tooltip names each ASSUMPTION constant in `names`, or null if none is one.
// Most tags are built once, so refreshAssumptionTags updates them all after a settings change.
export function assumptionTag(meta: SiteMeta | null, names: string[]): HTMLElement | null {
  if (!tagDescription(meta, names, {})) return null;
  const tag = el("span", "assumption-tag");
  tag.dataset.constants = names.join(",");
  tag.tabIndex = 0;
  describeTag(tag, meta, getState().params);
  return tag;
}

function refreshAssumptionTags(state: MissionState): void {
  for (const tag of document.querySelectorAll<HTMLElement>(".assumption-tag[data-constants]")) {
    describeTag(tag, state.meta, state.params);
  }
}

export function withTag(node: HTMLElement, tag: HTMLElement | null): HTMLElement {
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

export type PanelParts = {
  header: HTMLElement;
  left: HTMLElement; // the layer menu popover
  layersToggle: HTMLElement; // the button that opens it
  modes: HTMLElement; // Add stop / Start / End switch over the map
  right: HTMLElement; // the drawer with the Plan, Status and Contingency tabs
  dock: HTMLElement; // verdict, EVA clock, timeline slider
  profile: HTMLElement; // route profile sheet, closed by default
};

export function createPanels(parts: PanelParts): void {
  const header = buildHeader(parts.header);
  let left: ReturnType<typeof buildLeft> | null = null;
  let right: ReturnType<typeof buildRight> | null = null;
  const profile = buildProfile(parts.profile);

  const onState = (state: MissionState, previous: MissionState | null): void => {
    renderHeader(header, state);
    if (!state.meta) return;
    if (!left) {
      left = buildLeft(parts.left, parts.layersToggle, state.meta);
      right = buildRight(parts.right, parts.dock, parts.modes, parts.profile, state.meta);
      previous = null;
    }
    renderLeft(left, state);
    if (right) renderRight(right, state, previous);
    renderProfile(profile, state);
    if (!previous || previous.params !== state.params) refreshAssumptionTags(state);
  };
  subscribe(onState);
  onState(getState(), null);
}

// ---- Header: site name, engine status, offline state ----

function buildHeader(root: HTMLElement) {
  root.replaceChildren();
  const title = el("div", "app-title");
  title.append(el("span", "app-name", "Boxwork EVA Navigator"), el("span", "site-name", ""));
  // A tag with a status dot: the dot colour is set from data-status in style.css.
  const status = el("div", "engine-status");
  const dot = el("span", "status-dot");
  const text = el("span", "status-text", "loading");
  const calc = el("span", "status-calc num", "");
  status.append(dot, text, calc);
  const offline = el("span", "offline-badge", "offline: caching");
  offline.title = "The service worker stores the app and all site data, so the page works without a network after the first load.";
  const custom = el("span", "custom-badge", "custom settings");
  custom.title = "Some assumptions differ from docs/assumptions.md. See About the data.";
  const about = el("button", "mw-btn mw-btn-link", "About the data");
  about.type = "button";
  about.addEventListener("click", () => update({ aboutOpen: true }));
  // The one primary action of the screen: the crew display used during the walk.
  const helmet = el("button", "mw-btn mw-btn-primary", "Helmet mode");
  helmet.type = "button";
  helmet.title = "High-contrast crew display with quick commands and spoken answers. Esc to leave.";
  helmet.addEventListener("click", () => update({ helmet: true }));
  const right = el("div", "header-right");
  right.append(status, custom, offline, about, helmet);
  root.append(title, right);
  return { siteName: title.lastElementChild as HTMLElement, status, text, calc, offline, custom };
}

function renderHeader(refs: ReturnType<typeof buildHeader>, state: MissionState): void {
  refs.siteName.textContent = state.meta ? state.meta.name : "";
  refs.status.dataset.status = state.engine.status;
  const labels = { loading: "loading site", ready: "engine ready", calculating: "calculating", error: "engine error" };
  refs.text.textContent = labels[state.engine.status];
  const calc = state.engine.lastCalc;
  refs.calc.textContent = calc ? `last ${calc.request} ${Math.round(calc.ms)} ms` : "";
  refs.status.title = state.engine.error ?? refs.calc.textContent;
  refs.offline.textContent = state.offlineReady ? "offline ready" : "offline: caching";
  refs.offline.classList.toggle("ready", state.offlineReady);
  // Dev server has no service worker: hide the badge instead of showing a state that never changes.
  refs.offline.hidden = import.meta.env.DEV;
  refs.custom.hidden = Object.keys(state.params).length === 0;
}

// ---- Left: data layers ----

type LayerRow = { id: string; button: HTMLButtonElement };

function buildLeft(root: HTMLElement, toggle: HTMLElement, meta: SiteMeta) {
  root.replaceChildren();
  const box = section(root, "Data layers");
  const setOpen = (open: boolean): void => {
    root.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => setOpen(root.hidden));
  // Close when the user goes back to the map, so the menu never sits over the terrain they are working on.
  document.addEventListener("pointerdown", (event) => {
    const target = event.target as Node;
    const insideMenu = root.contains(target) || toggle.contains(target);
    if (!insideMenu) setOpen(false);
  });
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

  addRow("basemap", "HiRISE orthophoto", meta.tiles.source, `Color orthophoto mosaic, ${meta.tiles.metersPerPixelAtMaxZoom} m pixels at full zoom.`, null);
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
  // Each row names what it explains: a layer id, or a scenario whose path only shows during that simulation.
  legend.innerHTML = `
    <div class="legend-row" data-layer="envelope"><span class="swatch swatch-safe"></span>Safe return, reserve kept</div>
    <div class="legend-row" data-layer="envelope"><span class="swatch swatch-reserve"></span>Return only with the reserve</div>
    <div class="legend-row" data-layer="route"><span class="swatch swatch-route"></span>Planned route</div>
    <div class="legend-row" data-layer="route"><span class="swatch swatch-return"></span>Return path from crew</div>
    <div class="legend-row" data-layer="route" data-scenario="buddy_injured"><span class="swatch swatch-rescue"></span>Rescue path (buddy injured)</div>
    <div class="legend-row" data-layer="route" data-scenario="sep_event"><span class="swatch swatch-shelter"></span>Path to shelter (solar alert)</div>`;
  box.append(legend);
  const legendRows = Array.from(legend.querySelectorAll<HTMLElement>(".legend-row"));
  return { rows, toggle, legendRows };
}

function renderLeft(refs: ReturnType<typeof buildLeft>, state: MissionState): void {
  let dataLayersOn = 0;
  for (const row of refs.rows) {
    const visible = state.layers[row.id] === true;
    row.button.innerHTML = visible ? EYE_OPEN : EYE_CLOSED;
    row.button.classList.toggle("on", visible);
    row.button.setAttribute("aria-pressed", String(visible));
    const isDataLayer = state.meta?.overlays.some((overlay) => overlay.id === row.id) === true;
    if (visible && isDataLayer) dataLayersOn += 1;
  }
  refs.toggle.textContent = dataLayersOn > 0 ? `Layers · ${dataLayersOn} on` : "Layers";

  // The legend lists only what is on the map now.
  for (const row of refs.legendRows) {
    const layerOn = state.layers[row.dataset.layer ?? ""] === true;
    const scenario = row.dataset.scenario;
    const scenarioShown = scenario === undefined || state.scenario === scenario;
    row.hidden = !(layerOn && scenarioShown);
  }
}

// ---- Drawer tabs, map mode switch, bottom dock ----

type DrawerTab = "plan" | "status" | "contingency";

// Tabs at the top of the drawer. Only one tab's sections show at a time, so the drawer never becomes a long scroll.
// Sections opt in with data-tab. Returns the function that switches tabs.
function buildTabs(root: HTMLElement): (tab: DrawerTab) => void {
  const bar = el("div", "drawer-tabs");
  bar.setAttribute("role", "tablist");
  const labels: Record<DrawerTab, string> = { plan: "Plan", status: "Status", contingency: "Contingency" };
  const buttons = new Map<DrawerTab, HTMLButtonElement>();

  const show = (tab: DrawerTab): void => {
    for (const [id, button] of buttons) {
      button.setAttribute("aria-selected", String(id === tab));
      button.tabIndex = id === tab ? 0 : -1;
    }
    for (const box of root.querySelectorAll<HTMLElement>("[data-tab]")) box.hidden = box.dataset.tab !== tab;
    root.scrollTop = 0;
  };

  for (const tab of Object.keys(labels) as DrawerTab[]) {
    const button = el("button", "mw-btn mw-btn-outline drawer-tab", labels[tab]);
    button.type = "button";
    button.setAttribute("role", "tab");
    button.addEventListener("click", () => show(tab));
    buttons.set(tab, button);
    bar.append(button);
  }

  const hide = el("button", "drawer-hide", "Hide");
  hide.type = "button";
  hide.title = "Hide the panel to see the whole map (M)";
  hide.addEventListener("click", () => setDrawerOpen(false));
  bar.append(hide);
  root.prepend(bar);
  return show;
}

// The drawer state is a view preference, not mission state, so it lives on the page element and not in the store.
function setDrawerOpen(open: boolean): void {
  document.body.classList.toggle("drawer-closed", !open);
}

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

// ---- Right: plan, crew, energy, route summary, contingencies ----

function buildRight(root: HTMLElement, dock: HTMLElement, modes: HTMLElement, profile: HTMLElement, meta: SiteMeta) {
  root.replaceChildren();
  dock.replaceChildren();
  modes.replaceChildren();

  // Map mode switch: what the next map click sets. One group over the map instead of buttons in the panel.
  const modeButton = (mode: "stop" | "start" | "end", label: string): HTMLButtonElement => {
    const button = el("button", "mw-btn mw-btn-outline mode-option", label);
    button.type = "button";
    button.addEventListener("click", () => {
      const isSame = getState().placing === mode;
      update({ placing: isSame ? "stop" : mode });
    });
    modes.append(button);
    return button;
  };
  const addStopMode = modeButton("stop", "Add stop");
  const setStart = modeButton("start", "Set start");
  const setEnd = modeButton("end", "Set end");

  // Plan
  const plan = section(root, "Plan");
  plan.dataset.tab = "plan";
  const hint = el("div", "hint");
  const buttons = el("div", "button-row");
  const makeButton = (label: string, onClick: () => void): HTMLButtonElement => {
    const button = el("button", "btn", label);
    button.type = "button";
    button.addEventListener("click", onClick);
    buttons.append(button);
    return button;
  };
  const planScience = makeButton(AUTO_PLAN_LABEL, () => update({ scienceStatus: "requested" }));
  planScience.className = "mw-btn mw-btn-outline strong";
  planScience.title =
    "Picks stops from the Curiosity stops and the science-value peaks, habitat to habitat: each step adds the stop with the most science value per added joule, " +
    "while the plan keeps the energy reserve, the EVA time and the walk radius (docs/data-contract.md, 4.1). " +
    "Replaces your stops; start and end become the habitat.";
  makeButton("Start and end at habitat", () => update({ start: null, end: null, placing: "stop" })).className = "mw-btn mw-btn-link";
  makeButton("Clear stops", () => update({ stops: [], selectedStop: null })).className = "mw-btn mw-btn-link";
  const scienceNote = el("div", "science-note");
  const startEnd = el("div", "start-end num");
  const stopList = el("ol", "stop-list");
  const stopDetail = el("figure", "stop-detail");
  plan.append(hint, buttons, scienceNote, startEnd, stopList, stopDetail);

  // Timeline
  // The slider range is EVA_DURATION_H (a setting), set in renderRight.
  // The EVA clock and slider sit in the dock, always in view. The crew details sit in the Status tab.
  const timeline = section(root, "Crew");
  timeline.dataset.tab = "status";
  const sliderRow = el("div", "dock-clock");
  const elapsed = el("span", "dock-clock-value num", DASH);
  const total = el("span", "dock-clock-total num", `/ ${DASH}`);
  total.title = sourceTooltip(meta, "EVA_DURATION_H");
  const clockLabel = el("span", "mw-eyebrow", "EVA time");
  const clockValue = el("span", "dock-clock-numbers");
  clockValue.append(elapsed, total);
  sliderRow.append(clockLabel, clockValue);
  const slider = el("input", "timeline-slider");
  slider.type = "range";
  slider.min = "0";
  slider.step = String(TIMELINE_STEP_S);
  slider.setAttribute("aria-label", "Elapsed EVA time");
  slider.addEventListener("input", () => update({ elapsedS: Number(slider.value) }));
  const turnBack = statRow(timeline, "Turn back by", assumptionTag(meta, DEPENDS.turnBack));
  const crewAt = statRow(timeline, "Crew A position", assumptionTag(meta, DEPENDS.timeline));

  // Buddy: B walks the same plan, started later. Same scale as the EVA slider: a delay is a stretch of EVA time.
  const buddyHead = el("div", "slider-head buddy-head");
  // Starts at BUDDY_LAG_S (engine client, on meta.json load).
  const buddyLabel = withTag(el("span", "stat-label", "Buddy B starts later by"), assumptionTag(meta, ["BUDDY_LAG_S"]));
  buddyLabel.title = sourceTooltip(meta, "BUDDY_LAG_S");
  const buddyDelay = el("span", "slider-total num", DASH);
  buddyHead.append(buddyLabel, buddyDelay);
  const buddySlider = el("input", "timeline-slider");
  buddySlider.type = "range";
  buddySlider.min = "0";
  buddySlider.step = String(TIMELINE_STEP_S);
  buddySlider.value = "0";
  buddySlider.setAttribute("aria-label", "Delay of astronaut B behind astronaut A");
  buddySlider.addEventListener("input", () => update({ buddyDelayS: Number(buddySlider.value) }));
  timeline.append(buddyHead, buddySlider);
  const buddyAt = statRow(timeline, "Crew B position", assumptionTag(meta, DEPENDS.timeline));
  // Shown only after the user dragged B on the map (simulate bPosition).
  const resetBuddy = el("button", "btn btn-small", "Put B back on the timeline");
  resetBuddy.type = "button";
  resetBuddy.title = "B was dragged on the map. B's energy used stays the timeline value.";
  resetBuddy.addEventListener("click", () => update({ bPosition: null }));
  timeline.append(resetBuddy);
  const separation = statRow(timeline, "Buddy separation", assumptionTag(meta, DEPENDS.buddy));
  separation.title = sourceTooltip(meta, "BUDDY_MAX_SEPARATION_M");
  // " (limit N m)" after the label text, before the tag. BUDDY_MAX_SEPARATION_M is a setting, so set in renderRight.
  const separationLimit = el("span");
  const separationName = separation.previousElementSibling as HTMLElement;
  separationName.insertBefore(separationLimit, separationName.childNodes[1] ?? null);

  const timelineNote = el("div", "note");
  timeline.append(timelineNote);

  // Energy budget
  const energy = section(root, "Energy budget");
  energy.dataset.tab = "status";
  const budgetHead = withTag(el("div", "budget-head", "Used | remaining | reserve (hatched) | plan total (tick)"), assumptionTag(meta, DEPENDS.budget));
  const bar = el("div", "budget-bar");
  const reserve = el("div", "budget-reserve");
  const used = el("div", "budget-used");
  const planTick = el("div", "budget-plan");
  bar.append(reserve, used, planTick);
  energy.append(budgetHead, bar);
  // Used: Santee energy along the plan. Remaining: budget minus used. Reserve: budget x RESERVE_FRACTION.
  const usedValue = statRow(energy, "Used", assumptionTag(meta, DEPENDS.energy));
  const remainingValue = statRow(energy, "Remaining", assumptionTag(meta, [...DEPENDS.budget, ...DEPENDS.energy]));
  const reserveValue = statRow(energy, "Reserve section", assumptionTag(meta, DEPENDS.budget));
  const budgetValue = statRow(energy, "EVA budget", assumptionTag(meta, DEPENDS.budget));

  // Route summary
  const summary = section(root, "Route");
  summary.dataset.tab = "status";
  // The verdict is the first thing both crew members look at, so it sits in the dock. Its reasons stay here.
  const verdict = el("div", "verdict");
  verdict.title = "Rules: docs/assumptions.md, section Engine. Reasons: Status tab.";
  const distance = statRow(summary, "Distance", assumptionTag(meta, DEPENDS.routeTotals));
  const time = statRow(summary, "Time (walking + stops)", assumptionTag(meta, DEPENDS.routeTotals));
  const stopTime = statRow(summary, "Time at stops");
  stopTime.title = sourceTooltip(meta, "STOP_DWELL_MIN");
  const routeEnergy = statRow(summary, "Energy", assumptionTag(meta, DEPENDS.energy));
  const gain = statRow(summary, "Elevation gain", assumptionTag(meta, DEPENDS.routeTotals));
  const reasons = el("ul", "reasons");
  summary.append(reasons);

  // Contingencies: each button switches its scenario on or off. The event happens at the EVA slider time.
  const contingencies = section(root, "Contingencies");
  contingencies.dataset.tab = "contingency";
  const scenarioRow = el("div", "button-row");
  const scenarioButton = (scenario: Scenario, label: string, help: string): HTMLButtonElement => {
    const button = el("button", "btn", label);
    button.type = "button";
    button.title = help;
    button.addEventListener("click", () => update({ scenario: getState().scenario === scenario ? "none" : scenario }));
    scenarioRow.append(button);
    return button;
  };
  const sepButton = scenarioButton(
    "sep_event",
    "Simulate solar particle event",
    "Solar particle alert at the slider time: both crewmembers go to the full shelter that the later of the two reaches first.",
  );
  const injuredButton = scenarioButton(
    "buddy_injured",
    "Simulate buddy injured",
    "The chosen crewmember is injured at the slider time. The other one walks there, then carries them (both masses as load, rescue speed) to the habitat or a rover pickup zone.",
  );
  // Who is injured. The other crewmember is the rescuer.
  const injuredChoice = el("div", "choice");
  injuredChoice.setAttribute("role", "group");
  injuredChoice.setAttribute("aria-label", "Injured crewmember");
  injuredChoice.append(el("span", "choice-label", "Injured:"));
  const injuredOptions = (["A", "B"] as const).map((id) => {
    const option = el("button", "btn choice-option", id);
    option.type = "button";
    option.title = `Crewmember ${id} is the injured one`;
    option.addEventListener("click", () => update({ injured: id }));
    injuredChoice.append(option);
    return { id, option };
  });
  scenarioRow.append(injuredChoice);
  const contingencyBody = el("div", "contingency-body action-card");
  contingencies.append(scenarioRow, contingencyBody);
  const action = statRow(contingencyBody, "Recommended action");
  const crewRoles = statRow(contingencyBody, "Injured | rescuer");
  const target = statRow(contingencyBody, "Target");
  const actionTime = statRow(contingencyBody, "Time to target");
  const actionDistance = statRow(contingencyBody, "Distance to target", assumptionTag(meta, DEPENDS.routeTotals));
  const actionEnergy = statRow(contingencyBody, "Energy for the action", assumptionTag(meta, DEPENDS.energy));
  const scenarioTag = el("div", "scenario-tag");
  const contingencyNotes = el("ul", "reasons");
  // Solar particle alert: walking time of each crewmember to every shelter, and the sourced context.
  const shelterTable = el("table", "shelter-table");
  const sepContext = el("div", "sep-context");
  contingencyBody.append(scenarioTag, shelterTable, sepContext, contingencyNotes);

  // Status tab order: the budget first, then the route, then the crew details.
  root.append(plan, energy, summary, timeline, contingencies);
  const showTab = buildTabs(root);
  showTab("plan");

  // Dock: verdict, EVA clock, slider, then the two links that open the profile sheet and the drawer.
  const profileButton = el("button", "mw-btn mw-btn-link dock-link", "Profile");
  profileButton.type = "button";
  profileButton.setAttribute("aria-expanded", "false");
  profileButton.addEventListener("click", () => {
    profile.hidden = !profile.hidden;
    profileButton.setAttribute("aria-expanded", String(!profile.hidden));
  });
  const panelButton = el("button", "mw-btn mw-btn-link dock-link dock-panel", "Panel");
  panelButton.type = "button";
  panelButton.title = "Show the panel (M)";
  panelButton.addEventListener("click", () => setDrawerOpen(true));
  dock.append(verdict, sliderRow, slider, profileButton, panelButton);

  document.addEventListener("keydown", (event) => {
    const isToggleKey = event.key === "m" || event.key === "M";
    const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
    if (!isToggleKey || hasModifier || isTyping(event.target)) return;
    if (getState().helmet || getState().aboutOpen) return;
    setDrawerOpen(document.body.classList.contains("drawer-closed"));
  });

  return {
    meta,
    showTab,
    hint,
    addStopMode,
    planScience,
    scienceNote,
    setStart,
    setEnd,
    startEnd,
    stopList,
    stopDetail,
    elapsed,
    slider,
    turnBack,
    crewAt,
    buddyDelay,
    buddySlider,
    buddyAt,
    resetBuddy,
    separation,
    separationLimit,
    total,
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
    sepButton,
    injuredButton,
    injuredOptions,
    contingencyBody,
    action,
    crewRoles,
    target,
    actionTime,
    actionDistance,
    actionEnergy,
    scenarioTag,
    shelterTable,
    sepContext,
    contingencyNotes,
  };
}

// A science peak is known only from the last science plan (SciencePlan.candidates); it is not in meta.json.
function cellLabel(meta: SiteMeta, cell: Cell | null, fallback: string, plan: SciencePlan | null = null): string {
  if (!cell) return fallback;
  const waypoint = meta.waypoints.find((point) => sameCell(point, cell));
  if (waypoint) return `${waypoint.id} (${waypoint.name})`;
  if (sameCell(meta.habitat, cell)) return "habitat";
  const peak = plan ? plan.candidates.find((candidate) => candidate.kind === "peak" && sameCell(candidate, cell)) : undefined;
  if (peak) return `${peak.id} (${PEAK_LABEL})`;
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
    refs.addStopMode.setAttribute("aria-pressed", String(state.placing === "stop"));
    refs.setStart.setAttribute("aria-pressed", String(state.placing === "start"));
    refs.setEnd.setAttribute("aria-pressed", String(state.placing === "end"));
  }

  const scienceChanged = changed("scienceStatus") || changed("sciencePlan") || changed("scienceError") || changed("stops");
  if (scienceChanged || changed("engine")) renderScience(refs, state);

  if (changed("start") || changed("end")) {
    refs.startEnd.textContent = `Start: ${cellLabel(meta, state.start, "habitat")}  |  End: ${cellLabel(meta, state.end, "habitat")}`;
  }

  if (changed("stops") || changed("selectedStop")) {
    refs.stopList.replaceChildren();
    state.stops.forEach((stop, index) => {
      const item = el("li", state.selectedStop === index ? "selected" : "");
      const label = el("button", "stop-label", `${index + 1}. ${cellLabel(meta, stop, "", state.sciencePlan)}`);
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
    renderStopDetail(refs, state);
  }

  if (changed("params")) {
    const evaHours = paramNumber(state, "EVA_DURATION_H");
    const maxS = evaHours === null ? 0 : evaHours * SECONDS_PER_HOUR;
    refs.total.textContent = evaHours === null ? `/ ${DASH}` : `/ ${formatClock(maxS)}`;
    for (const slider of [refs.slider, refs.buddySlider]) {
      slider.max = String(maxS);
      slider.disabled = evaHours === null;
    }
    const limitM = paramNumber(state, "BUDDY_MAX_SEPARATION_M");
    refs.separationLimit.textContent = limitM === null ? "" : ` (limit ${limitM} m)`;
  }

  // Timeline. Do not move the slider under the user's pointer.
  if (changed("elapsedS")) {
    refs.elapsed.textContent = formatClock(state.elapsedS);
    if (document.activeElement !== refs.slider) refs.slider.value = String(state.elapsedS);
  }
  if (changed("buddyDelayS")) {
    refs.buddyDelay.textContent = formatClock(state.buddyDelayS);
    if (document.activeElement !== refs.buddySlider) refs.buddySlider.value = String(state.buddyDelayS);
  }
  if (changed("envelope") || changed("crewCell") || changed("sim") || changed("timelineError")) {
    const turnBackS = state.envelope ? state.envelope.turnBackAtS : null;
    refs.turnBack.textContent = formatClock(turnBackS);
    const mustReturn = isNumber(turnBackS) && state.elapsedS >= turnBackS;
    refs.turnBack.classList.toggle("warn", mustReturn);
    refs.crewAt.textContent = cellLabel(meta, state.crewCell, DASH, state.sciencePlan);
    const buddy = state.sim ? state.sim.astronauts.find((astronaut) => astronaut.id === "B") : undefined;
    const buddyText = cellLabel(meta, buddy ? buddy.cell : null, DASH, state.sciencePlan);
    refs.buddyAt.textContent = state.bPosition ? `${buddyText} (dragged)` : buddyText;
    refs.resetBuddy.hidden = state.bPosition === null;
    // The engine adds the separation warning line itself (sim.warnings); here the number turns amber too.
    const separationM = state.sim ? state.sim.separationM : null;
    const limitM = paramNumber(state, "BUDDY_MAX_SEPARATION_M");
    refs.separation.textContent = formatDistance(separationM);
    refs.separation.classList.toggle("warn", isNumber(separationM) && isNumber(limitM) && separationM > limitM);
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
    const reserveFraction = paramNumber(state, "RESERVE_FRACTION");
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
  // A simulated event opens its tab and the drawer, so the action card is in view without searching.
  const scenarioStarted = previous !== null && changed("scenario") && state.scenario !== "none";
  if (scenarioStarted) {
    refs.showTab("contingency");
    setDrawerOpen(true);
  }
  const contingencyChanged = changed("scenario") || changed("contingency") || changed("contingencyError") || changed("injured");
  if (contingencyChanged) renderContingency(refs, state);
}

const ACTION_TEXT: Record<SimState["recommendedAction"], string> = {
  continue: "Continue the plan",
  return: "Return to the habitat",
  go_to_shelter: "Go to the shelter",
  go_to_rover_pickup: "Go to the rover pickup zone",
};

function renderContingency(refs: ReturnType<typeof buildRight>, state: MissionState): void {
  refs.sepButton.classList.toggle("active", state.scenario === "sep_event");
  refs.injuredButton.classList.toggle("active", state.scenario === "buddy_injured");
  refs.sepButton.setAttribute("aria-pressed", String(state.scenario === "sep_event"));
  refs.injuredButton.setAttribute("aria-pressed", String(state.scenario === "buddy_injured"));
  refs.contingencyBody.hidden = state.scenario === "none";
  for (const { id, option } of refs.injuredOptions) {
    option.classList.toggle("active", state.injured === id);
    option.setAttribute("aria-pressed", String(state.injured === id));
  }
  refs.contingencyNotes.replaceChildren();
  refs.scenarioTag.replaceChildren();
  refs.shelterTable.replaceChildren();
  refs.sepContext.replaceChildren();
  document.body.classList.toggle("alert-sep", state.scenario === "sep_event");

  const sim = state.contingency;
  if (!sim) {
    for (const value of [refs.action, refs.crewRoles, refs.target, refs.actionTime, refs.actionDistance, refs.actionEnergy]) value.textContent = DASH;
    if (state.contingencyError) refs.contingencyNotes.append(el("li", "", state.contingencyError));
    return;
  }

  // In "buddy_injured", "return" means the rescuer carries the injured crewmember to the habitat.
  const injured = sim.astronauts.find((crew) => crew.status === "injured");
  const rescuer = sim.astronauts.find((crew) => crew.status === "rescuer");
  const carrying = sim.scenario === "buddy_injured" && sim.recommendedAction !== "continue" && injured && rescuer;
  let actionText = ACTION_TEXT[sim.recommendedAction];
  if (carrying) {
    const where = sim.recommendedAction === "return" ? "the habitat" : "the rover pickup zone";
    actionText = `${rescuer.id} carries ${injured.id} to ${where}`;
  }
  refs.action.textContent = actionText;
  refs.crewRoles.textContent = injured && rescuer ? `${injured.id} | ${rescuer.id}` : DASH;
  const rolesRow = refs.crewRoles.parentElement;
  if (rolesRow) rolesRow.hidden = sim.scenario !== "buddy_injured";
  refs.target.textContent = sim.actionTargetId ?? "none reachable";
  const hasPath = sim.actionPath.length > 0;
  refs.actionTime.textContent = hasPath ? formatDuration(sim.actionTimeS) : DASH;
  refs.actionDistance.textContent = hasPath ? formatDistance(sim.actionDistanceM) : DASH;
  refs.actionEnergy.textContent = hasPath ? formatMJ(sim.actionEnergyJ) : DASH;

  const event = sim.scenario === "sep_event" ? "Solar particle alert" : `Crewmember ${injured ? injured.id : DASH} injured`;
  const eventLine = el("span", "", `${event} at EVA time ${formatClock(sim.timeS)}. Map: this event's safe area and path.`);
  const depends = sim.scenario === "sep_event" ? DEPENDS.sepEvent : DEPENDS.rescue;
  refs.scenarioTag.append(withTag(eventLine, assumptionTag(refs.meta, depends)));
  const isSep = sim.scenario === "sep_event";
  if (isSep) renderShelters(refs, sim);
  // The SEP_ARRIVAL line is in the sourced context above, so it is not repeated here.
  const warnings = isSep ? sim.warnings.filter((line) => !line.includes("SEP_ARRIVAL")) : sim.warnings;
  for (const warning of warnings) refs.contingencyNotes.append(el("li", "", warning));
}

// One row per shelter: kind, walking time of A and B. The chosen full shelter is marked. Only sourced radiation
// context below: no dose rate is invented (docs/assumptions.md, "Radiation").
function renderShelters(refs: ReturnType<typeof buildRight>, sim: SimState): void {
  const meta = refs.meta;
  const head = el("tr");
  for (const title of ["Shelter", "Crew A", "Crew B"]) head.append(el("th", "", title));
  refs.shelterTable.append(head);
  for (const option of sim.shelters) {
    const row = el("tr", option.shelterId === sim.actionTargetId ? "chosen" : "");
    const name = el("td");
    if (option.kind === "full") {
      name.append(withTag(el("span", "", `${option.shelterId} (full)`), assumptionTag(meta, ["FULL_SHELTERS"])));
    } else {
      const openSky = option.openSkyShare === null ? "" : `, open sky ${Math.round(option.openSkyShare * 100)}%`;
      name.append(withTag(el("span", "", `Terrain: partial shielding only${openSky}`), assumptionTag(meta, DEPENDS.partialShelter)));
    }
    row.append(name, el("td", "num", formatDuration(option.timeS.A)), el("td", "num", formatDuration(option.timeS.B)));
    refs.shelterTable.append(row);
  }

  const dose = meta.constants.SEP_MAY2024_TOTAL_UGY;
  const arrival = meta.constants.SEP_ARRIVAL;
  if (dose) {
    const doseUgy = Number(dose.value).toLocaleString("en-US");
    const line = el("div", "", `May 2024 event, total dose beside Curiosity: ${doseUgy} uGy (no shelter)`);
    line.title = sourceTooltip(meta, "SEP_MAY2024_TOTAL_UGY");
    refs.sepContext.append(line);
  }
  if (arrival) {
    const line = el("div", "", `Particles can arrive within ${arrival.value}`);
    line.title = sourceTooltip(meta, "SEP_ARRIVAL");
    refs.sepContext.append(line);
  }
}

// The selected stop, when it is a Curiosity stop: its image from that stop (meta.json waypoint pov) and where it comes from.
function renderStopDetail(refs: ReturnType<typeof buildRight>, state: MissionState): void {
  refs.stopDetail.replaceChildren();
  const stop = state.selectedStop === null ? null : state.stops[state.selectedStop];
  const waypoint = stop ? refs.meta.waypoints.find((point) => sameCell(point, stop)) : undefined;
  refs.stopDetail.hidden = !waypoint;
  if (!waypoint) return;
  if (waypoint.pov) {
    const image = el("img");
    image.src = state.siteUrl + waypoint.pov;
    image.alt = `Curiosity image taken at ${waypoint.id}`;
    image.loading = "lazy";
    refs.stopDetail.append(image);
  }
  const caption = el("figcaption");
  const where = `${waypoint.id}: ${waypoint.name}, rover site ${waypoint.roverSite}, drive ${waypoint.roverDrive}.`;
  const credits = [waypoint.povCredit ? `Image: ${waypoint.povCredit}.` : "No Curiosity image assigned.", `Position: ${waypoint.source}.`];
  caption.append(el("span", "", `${where} ${credits.join(" ")}`));
  const value = el("div", "", `Science value ${waypoint.scienceValue} of ${SCIENCE_VALUE_MAX}`);
  caption.append(withTag(value, assumptionTag(refs.meta, OVERLAY_DEPENDS.science)));
  refs.stopDetail.append(caption);
}

function renderScience(refs: ReturnType<typeof buildRight>, state: MissionState): void {
  const engineUsable = state.engine.status === "ready" || state.engine.status === "calculating";
  const busy = state.scienceStatus !== "idle";
  refs.planScience.disabled = busy || !engineUsable;
  refs.planScience.textContent = busy ? "Planning stops..." : AUTO_PLAN_LABEL;

  refs.scienceNote.replaceChildren();
  if (state.scienceError) {
    refs.scienceNote.append(`Science planner failed: ${state.scienceError}`);
    return;
  }
  const plan = state.sciencePlan;
  const planIsShown = plan !== null && state.stops === plan.stops;
  if (!planIsShown) return;
  if (plan.stopIds.length === 0) {
    refs.scienceNote.append("No stop fits the energy reserve, EVA time and walk radius.");
    return;
  }
  const peakCount = plan.stopIds.filter((id) => plan.candidates.some((candidate) => candidate.id === id && candidate.kind === "peak")).length;
  const peaks = peakCount > 0 ? ` ${peakCount} of them are science peaks (no Curiosity image).` : "";
  const text = el("span", "", `Science plan: ${plan.stopIds.join(", ")}. Total science value ${plan.totalValue}.${peaks}`);
  refs.scienceNote.append(withTag(text, assumptionTag(refs.meta, DEPENDS.science)));
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
export function crewDistanceM(route: Route, crewCell: Cell | null, elapsedS: number): number | null {
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

// SVG text cannot hold the HTML tag: " (assumption)" in the text, and the constant list as a hover <title>.
function svgLabel(meta: SiteMeta | null, names: string[], attrs: Record<string, string | number>, text: string): SVGElement {
  const tag = assumptionTag(meta, names);
  const label = svgNode("text", attrs, tag ? `${text} (assumption)` : text);
  if (tag) label.append(svgNode("title", {}, tag.title));
  return label;
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
  const reserveFraction = paramNumber(state, "RESERVE_FRACTION");
  const energyMax = Math.max(route.totalEnergyJ, budgetJ ?? 0) * 1.05 || 1;
  const yEnergy = (j: number): number => energyBottom - (j / energyMax) * (energyBottom - energyTop);

  const grid = svgNode("g", { class: "chart-grid" });
  const axes = svgNode("g", { class: "chart-axis" });
  svg.append(grid, axes);

  // Titles
  axes.append(svgLabel(meta, DEPENDS.route, { x: plotLeft, y: elevTop - 8, class: "chart-title" }, "Elevation (m, areoid)"));
  axes.append(svgLabel(meta, DEPENDS.energy, { x: plotLeft, y: energyTop - 8, class: "chart-title" }, "Cumulative energy (MJ), points at stops"));

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
    svg.append(svgLabel(meta, ["EVA_ENERGY_BUDGET_J"], { class: "limit-label", x: plotRight - 4, y: yEnergy(budgetJ) - 4 }, "EVA budget"));
    if (isNumber(reserveFraction)) {
      const limitJ = budgetJ * (1 - reserveFraction);
      svg.append(svgNode("line", { class: "limit-line reserve", x1: plotLeft, x2: plotRight, y1: yEnergy(limitJ), y2: yEnergy(limitJ) }));
      // Below its line: the budget label sits above the budget line, and the two lines are close.
      svg.append(svgLabel(meta, DEPENDS.budget, { class: "limit-label", x: plotRight - 4, y: yEnergy(limitJ) + 12 }, "Reserve starts"));
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
  const energyTag = assumptionTag(meta, DEPENDS.energy);
  const energyTagHtml = energyTag ? ` ${energyTag.outerHTML}` : "";
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
      <div>Energy at last point <span class="num">${formatMJ(energyBefore ? energyBefore.energyJ : null)}</span>${energyTagHtml}</div>`;
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
