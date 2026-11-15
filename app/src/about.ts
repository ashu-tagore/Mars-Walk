// The About page (docs/data-contract.md, section 2; docs/assumptions.md): a full-screen editorial page over the map.
// Shows how the planner works, meta.json `sources` and `notes`, every ASSUMPTION constant with its reason, and the
// settings form for the values docs/assumptions.md marks "Adjustable". The form only writes `params` to the store; the engine client sends
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
  const page = el("div", "about-page");
  page.hidden = true;
  page.setAttribute("role", "dialog");
  page.setAttribute("aria-modal", "true");
  page.setAttribute("aria-label", "About the data and assumptions");
  container.append(page);

  const bar = el("div", "about-bar");
  const name = el("span", "about-bar-name", "Boxwork EVA Navigator");
  const close = el("button", "mw-btn mw-btn-primary", "Back to the map");
  close.type = "button";
  close.addEventListener("click", () => update({ aboutOpen: false }));
  bar.append(name, close);
  const body = el("div", "about-body");
  page.append(bar, body);

  let built = false;
  const inputs = new Map<string, HTMLInputElement>();
  const docsValues = new Map<string, HTMLElement>();
  const settingsNote = el("div", "note");
  const reveal = createReveal(page);

  const build = (state: MissionState): void => {
    const meta = state.meta;
    if (!meta) return;
    built = true;

    // Hero: the one oversized headline of the page, then the lead, then a real Curiosity image from the site.
    const hero = el("section", "about-hero");
    const heroText = el("div", "about-hero-text");
    heroText.dataset.revealGroup = "";
    heroText.append(
      revealed(el("div", "mw-eyebrow", "About")),
      revealed(el("h1", "about-display", "Walk the boxwork.")),
      revealed(
        el(
          "p",
          "about-lead",
          `An offline planner for a two-person walk on Mars at the ${meta.name}. It tells the crew which science stops are worth the energy, which route to walk, when to turn back, and what to do if a solar storm starts or one of them is injured. Everything runs in the browser, with no server.`,
        ),
      ),
    );
    hero.append(heroText);
    const heroStop = meta.waypoints.find((point) => point.pov);
    if (heroStop?.pov) {
      const figure = revealed(el("figure", "about-hero-media"));
      const image = el("img");
      image.src = state.siteUrl + heroStop.pov;
      image.alt = `Curiosity image taken at stop ${heroStop.id}`;
      image.loading = "lazy";
      const credit = heroStop.povCredit ? ` Image: ${heroStop.povCredit}.` : "";
      figure.append(image, el("figcaption", "", `${heroStop.name}, stop ${heroStop.id}.${credit}`));
      hero.append(figure);
    }

    // How it works: one card per engine idea, text from the README.
    const how = el("section", "about-section");
    how.append(revealed(el("h2", "about-heading", "How it works")));
    const cards = el("div", "about-cards");
    cards.dataset.revealGroup = "";
    for (const [title, text] of HOW_IT_WORKS) {
      const card = revealed(el("article", "about-card"));
      card.append(el("h3", "about-card-title", title), el("p", "", text));
      cards.append(card);
    }
    how.append(cards);

    // Green band: the site in numbers, all read from meta.json.
    const band = el("section", "about-band");
    const bandInner = el("div", "about-band-inner");
    bandInner.append(revealed(el("h2", "about-band-heading", "Every number has a source, or says it is our choice.")));
    const statuses = Object.values(meta.constants).map((entry) => entry.status);
    const sourced = statuses.filter((status) => status === "SOURCED").length;
    const assumed = statuses.filter((status) => status === "ASSUMPTION").length;
    const sideKm = (Math.max(meta.width, meta.height) * meta.cellSizeMeters) / 1000;
    const facts: [string, string][] = [
      [`${sideKm} km`, "site width, one routing grid"],
      [`${meta.cellSizeMeters} m`, "routing cell size"],
      [String(meta.waypoints.length), "real Curiosity stops"],
      [`${sourced} / ${assumed}`, "constants sourced / assumed"],
    ];
    const factGrid = el("div", "about-facts");
    factGrid.dataset.revealGroup = "";
    for (const [value, label] of facts) {
      const fact = revealed(el("div", "about-fact"));
      fact.append(el("div", "about-fact-value num", value), el("div", "about-fact-label", label));
      factGrid.append(fact);
    }
    bandInner.append(factGrid);
    band.append(bandInner);

    // Settings
    const settings = el("section", "about-section");
    settings.append(revealed(el("h2", "about-heading", "Settings")));
    const settingsCard = revealed(el("div", "about-settings"));
    settingsCard.append(
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
    const reset = el("button", "mw-btn mw-btn-link", "Reset all to the documented values");
    reset.type = "button";
    reset.addEventListener("click", () => update({ params: {} }));
    settingsCard.append(table, reset, settingsNote);
    const fixed = PIPELINE_SETTINGS.map((name) => `${name} = ${meta.constants[name]?.value ?? "?"}`).join(", ");
    settingsCard.append(el("p", "about-text", `Fixed in the site files (run the pipeline again to change): ${fixed}.`));
    settings.append(settingsCard);

    // Data sources: a rule-separated list, label left, credit and link right.
    const sources = el("section", "about-section");
    sources.append(revealed(el("h2", "about-heading", "Data sources")));
    const sourceList = el("ul", "about-rows");
    sourceList.dataset.revealGroup = "";
    for (const source of meta.sources) {
      const item = revealed(el("li", "about-row"));
      const link = el("a", "", source.url);
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener";
      const detail = el("div", "about-row-detail");
      detail.append(el("div", "", source.credit), link);
      item.append(el("div", "about-row-title", source.label), detail);
      sourceList.append(item);
    }
    sources.append(sourceList);

    // Data limits
    const limits = el("section", "about-section");
    limits.append(revealed(el("h2", "about-heading", "Data limits")));
    const noteList = el("ul", "about-rows");
    noteList.dataset.revealGroup = "";
    for (const note of meta.notes) noteList.append(revealed(el("li", "about-row about-row-text", note.text)));
    limits.append(noteList);

    // Every assumption: a long list, so it opens on request.
    const assumptions = el("section", "about-section");
    assumptions.append(revealed(el("h2", "about-heading", "Assumptions")));
    const details = revealed(el("details", "about-details"));
    details.append(el("summary", "", `Show all ${assumed} assumptions (docs/assumptions.md)`));
    const assumptionList = el("ul", "about-rows");
    for (const [constantName, entry] of Object.entries(meta.constants)) {
      if (entry.status !== "ASSUMPTION") continue;
      const item = el("li", "about-row");
      const value = el("div", "about-row-title");
      value.append(el("code", "", constantName), el("div", "about-row-value num", entry.value));
      item.append(value, el("div", "about-row-detail", entry.source));
      assumptionList.append(item);
    }
    details.append(assumptionList);
    assumptions.append(details);

    const footer = el("footer", "about-footer");
    footer.append(
      el("div", "mw-eyebrow", "Credits"),
      el(
        "p",
        "",
        "HiRISE: NASA/JPL-Caltech/UArizona. DEM and orthophoto mosaics: Calef and Parker (2016), USGS Astrogeology. THEMIS: NASA/JPL-Caltech/ASU. CRISM: NASA/JHU-APL. Curiosity images and RAD: NASA/JPL-Caltech/SwRI.",
      ),
    );

    body.append(hero, how, band, settings, sources, limits, assumptions, footer);
  };

  const render = (state: MissionState): void => {
    const wasHidden = page.hidden;
    page.hidden = !state.aboutOpen;
    document.body.classList.toggle("about-open", state.aboutOpen);
    if (!state.aboutOpen) return;
    if (!built) build(state);
    if (wasHidden) {
      page.scrollTop = 0;
      reveal();
      close.focus();
    }
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

// Text from the README, section "How it works".
const HOW_IT_WORKS: [string, string][] = [
  ["Terrain", "A 1 m HiRISE elevation model, averaged to 3 m cells. Slopes above 20 deg cannot be walked; 15 to 20 deg cost more."],
  ["Energy", "Each step costs energy from the Santee et al. (2001) load-carriage model at Mars gravity. Uphill costs more than downhill, so the way out and the way back differ."],
  ["Walk-back area", "From every cell, the energy and time needed to get back to the habitat. It shrinks as the walk goes on."],
  ["Buddy rescue", "One astronaut carries the other, at most 2 km. If the habitat is out of reach, the rescuer goes to the nearest rover pickup zone."],
  ["Radiation", "Only the habitat and the rover are full shelters. No dose rates are invented: the app quotes only the measured May 2024 total beside Curiosity."],
  ["Science planner", "Adds the stop with the most science value per extra joule while the plan keeps the energy reserve, EVA time and walk radius."],
];

// Marks an element to fade and rise once when it scrolls into view.
function revealed<T extends HTMLElement>(node: T): T {
  node.classList.add("reveal");
  return node;
}

// Scroll-into-view reveal inside the page's own scroller. Each element plays once and then stays.
// Siblings in one [data-reveal-group] get a stagger index, capped at 5 so long lists keep up with the scroll.
// Returns a function that starts watching the elements built so far; call it each time the page opens.
function createReveal(scroller: HTMLElement): () => void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canObserve = "IntersectionObserver" in window;
  // Fire a little before the element is fully in view, so the motion ends as the eye arrives.
  const observer = canObserve
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.add("is-visible");
            observer?.unobserve(entry.target);
          }
        },
        { root: scroller, threshold: 0.15, rootMargin: "0px 0px -8% 0px" },
      )
    : null;

  return () => {
    for (const group of scroller.querySelectorAll<HTMLElement>("[data-reveal-group]")) {
      const items = group.querySelectorAll<HTMLElement>(".reveal");
      items.forEach((item, index) => item.style.setProperty("--reveal-index", String(Math.min(index, 5))));
    }
    const waiting = scroller.querySelectorAll<HTMLElement>(".reveal:not(.is-visible)");
    for (const node of waiting) {
      if (reduceMotion || !observer) node.classList.add("is-visible");
      else observer.observe(node);
    }
  };
}
