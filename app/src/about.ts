// "About the data and assumptions" dialog (docs/data-contract.md, section 2; docs/assumptions.md).
// Shows meta.json `sources` and `notes`, every ASSUMPTION constant with its reason, and the settings form for the
// values docs/assumptions.md marks "Adjustable". The form only writes `params` to the store; the engine client sends
// them with setParams, so every number on screen is recalculated by the engine.

import { JOULES_PER_MJ, SECONDS_PER_HOUR } from "./panels";
import { type MissionState, constantNumber, getState, subscribe, update } from "./store";

type Setting = {
  name: string;
  label: string;
  unit: string;
  // The input shows value / scale (EVA_ENERGY_BUDGET_J in MJ, the engine takes J).
  scale: number;
  min: number;
  max?: number;
  // True when an empty input means "derived" (engine Params: EVA_ENERGY_BUDGET_J null).
  derivable: boolean;
};

// docs/assumptions.md rows marked "Adjustable" that the engine takes at runtime (engine Params).
// min 0: applyParams rejects negative values. EVA_DURATION_H: the documented range is 4 to 8 h.
const SETTINGS: Setting[] = [
  { name: "EVA_DURATION_H", label: "EVA duration", unit: "h", scale: 1, min: 4, max: 8, derivable: false },
  { name: "STOP_DWELL_MIN", label: "Time at each stop", unit: "min", scale: 1, min: 0, derivable: false },
  { name: "RESERVE_FRACTION", label: "Energy reserve (share of the budget, below 1)", unit: "", scale: 1, min: 0, max: 1, derivable: false },
  { name: "BUDDY_MAX_SEPARATION_M", label: "Buddy separation limit", unit: "m", scale: 1, min: 0, derivable: false },
  { name: "SUIT_AND_GEAR_MASS_KG", label: "Suit and gear mass", unit: "kg", scale: 1, min: 0, derivable: false },
  { name: "RESCUE_SPEED_M_PER_S", label: "Speed while carrying a crewmember", unit: "m/s", scale: 1, min: 0, derivable: false },
  { name: "SEP_SHELTER_TARGET_MIN", label: "Shelter time target in a solar alert", unit: "min", scale: 1, min: 0, derivable: false },
  { name: "EVA_ENERGY_BUDGET_J", label: "EVA energy budget", unit: "MJ", scale: JOULES_PER_MJ, min: 0, derivable: true },
];

// Also "Adjustable" in docs/assumptions.md, but fixed in terrain_cost.bin (docs/data-contract.md, section 1).
const PIPELINE_SETTINGS = ["ROUGHNESS_COST_PER_M", "BOULDER_COST_FACTOR"];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Store write for one input. An empty input resets the setting to the docs value.
function applyInput(setting: Setting, raw: string): void {
  const state = getState();
  const params = { ...state.params };
  const text = raw.trim();
  if (text === "") {
    delete params[setting.name];
    update({ params });
    return;
  }
  const value = Number(text) * setting.scale;
  if (!Number.isFinite(value)) return;
  params[setting.name] = value;
  // A shorter EVA must not leave the timeline past its end.
  if (setting.name === "EVA_DURATION_H") {
    const maxS = value * SECONDS_PER_HOUR;
    update({ params, elapsedS: Math.min(state.elapsedS, maxS), buddyDelayS: Math.min(state.buddyDelayS, maxS) });
    return;
  }
  update({ params });
}

export function createAbout(container: HTMLElement): void {
  const backdrop = el("div", "about-backdrop");
  backdrop.hidden = true;
  backdrop.addEventListener("click", (event) => {
    if (event.target === backdrop) update({ aboutOpen: false });
  });
  const dialog = el("div", "about");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-label", "About the data and assumptions");
  backdrop.append(dialog);
  container.append(backdrop);

  const close = el("button", "btn", "Close");
  close.type = "button";
  close.addEventListener("click", () => update({ aboutOpen: false }));
  const head = el("div", "about-head");
  head.append(el("h2", "about-title", "About the data and assumptions"), close);
  const body = el("div", "about-body");
  dialog.append(head, body);

  let built = false;
  const inputs = new Map<string, HTMLInputElement>();
  const docsValues = new Map<string, HTMLElement>();
  const settingsNote = el("div", "note");

  const build = (state: MissionState): void => {
    const meta = state.meta;
    if (!meta) return;
    built = true;

    // Settings
    const settings = el("section", "about-section");
    settings.append(el("h3", "", "Settings"));
    settings.append(
      el("p", "about-text", "These values are our choices (ASSUMPTION in docs/assumptions.md). Change one and the engine recalculates every number. Leave a box empty for the documented value."),
    );
    const table = el("div", "settings-grid");
    for (const setting of SETTINGS) {
      const entry = meta.constants[setting.name];
      const label = el("label", "settings-label", setting.label);
      label.htmlFor = `setting-${setting.name}`;
      label.title = entry ? `${setting.name} (${entry.status}): ${entry.source}` : setting.name;
      const input = el("input", "settings-input num");
      input.id = `setting-${setting.name}`;
      input.type = "number";
      input.step = "any";
      input.min = String(setting.min);
      if (setting.max !== undefined) input.max = String(setting.max);
      input.addEventListener("change", () => applyInput(setting, input.value));
      const docs = el("span", "settings-docs num");
      table.append(label, input, el("span", "settings-unit", setting.unit), docs);
      inputs.set(setting.name, input);
      docsValues.set(setting.name, docs);
    }
    const reset = el("button", "btn", "Reset all to the documented values");
    reset.type = "button";
    reset.addEventListener("click", () => update({ params: {} }));
    settings.append(table, reset, settingsNote);
    const fixed = PIPELINE_SETTINGS.map((name) => `${name} = ${meta.constants[name]?.value ?? "?"}`).join(", ");
    settings.append(el("p", "about-text", `Fixed in the site files (run the pipeline again to change): ${fixed}.`));

    // Data sources
    const sources = el("section", "about-section");
    sources.append(el("h3", "", "Data sources"));
    const sourceList = el("ul", "about-list");
    for (const source of meta.sources) {
      const item = el("li");
      const link = el("a", "", source.url);
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener";
      item.append(el("strong", "", source.label), ` (${source.credit}). `, link);
      sourceList.append(item);
    }
    sources.append(sourceList);

    // Data limits
    const limits = el("section", "about-section");
    limits.append(el("h3", "", "Data limits"));
    const noteList = el("ul", "about-list");
    for (const note of meta.notes) noteList.append(el("li", "", note.text));
    limits.append(noteList);

    // Every assumption
    const assumptions = el("section", "about-section");
    assumptions.append(el("h3", "", "Assumptions (docs/assumptions.md)"));
    const assumptionList = el("ul", "about-list");
    for (const [name, entry] of Object.entries(meta.constants)) {
      if (entry.status !== "ASSUMPTION") continue;
      const item = el("li");
      item.append(el("code", "", name), ` = ${entry.value}. ${entry.source}`);
      assumptionList.append(item);
    }
    assumptions.append(assumptionList);

    body.append(settings, sources, limits, assumptions);
  };

  const render = (state: MissionState): void => {
    const wasHidden = backdrop.hidden;
    backdrop.hidden = !state.aboutOpen;
    if (!state.aboutOpen) return;
    if (!built) build(state);
    if (wasHidden) close.focus();
    for (const setting of SETTINGS) {
      const input = inputs.get(setting.name) as HTMLInputElement;
      const docs = docsValues.get(setting.name) as HTMLElement;
      const docsValue = constantNumber(state.meta, setting.name);
      const docsText = setting.derivable ? "derived from the EVA duration" : `${docsValue ?? "?"} ${setting.unit}`.trim();
      docs.textContent = `docs: ${docsText}`;
      if (document.activeElement === input) continue; // do not overwrite what the user is typing
      const value = state.params[setting.name];
      input.value = typeof value === "number" ? String(value / setting.scale) : "";
      input.placeholder = setting.derivable ? "derived" : String(docsValue ?? "");
    }
    const changed = Object.keys(state.params).length;
    settingsNote.textContent = state.paramsError
      ? `The engine rejected the change: ${state.paramsError}`
      : changed > 0
        ? `${changed} setting(s) differ from docs/assumptions.md. Assumption tags still describe the documented values.`
        : "";
  };
  subscribe((state) => render(state));
  render(getState());
}
