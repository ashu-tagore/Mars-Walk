// The 2D map. It only renders store state and turns user clicks into store updates.
// It knows nothing about the engine. A 3D view can replace this file in Phase 4 without touching anything else:
// it needs the same two things, createMapView(container) and the store.

import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { type Cell, cellToLatLng, gridBounds, latLngToCell, tileZoomOffset } from "./coords";
import { type Envelope, type MissionState, type SiteMeta, addStop, getState, moveStop, removeStop, subscribe, update } from "./store";

// Envelope colors, RGBA. Mask values: docs/data-contract.md, Envelope (0 = cannot return, 1 = reserve only, 2 = safe).
const ENVELOPE_SAFE_RGBA = [46, 204, 113, 72];
const ENVELOPE_RESERVE_RGBA = [255, 176, 32, 120];

// docs/assumptions.md, "App display" (reasons there).
const OVERLAY_OPACITY = 0.75;
// Leaflet zoom z draws 2^z pixels per meter. -3 shows the whole 3 km site in about 375 px; 4 is 16 px per meter.
const MAP_MIN_ZOOM = -3;
const MAP_MAX_ZOOM = 4;
// Share of the site size the user may pan past the edge.
const PAN_MARGIN_FRACTION = 0.25;
// docs/assumptions.md, "Units": the uint8 science value scale (docs/data-contract.md, section 1).
const SCIENCE_VALUE_MAX = 255;
// docs/assumptions.md, "Units".
const SECONDS_PER_MINUTE = 60;

// A 1 x 1 transparent GIF, shown while there is no envelope.
const EMPTY_IMAGE = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

type MapView = {
  map: L.Map;
  meta: SiteMeta;
  // Layer id (as in store.layers) -> Leaflet layer.
  layers: Record<string, L.Layer>;
  envelopeOverlay: L.ImageOverlay;
  envelopeCanvas: HTMLCanvasElement;
  envelopeUrl: string | null;
  envelopeDrawId: number;
  routeGlow: L.Polyline;
  routeCore: L.Polyline;
  returnPath: L.Polyline;
  rescuePath: L.Polyline;
  shelterPath: L.Polyline;
  alertMarkers: L.LayerGroup;
  alertBanner: HTMLElement;
  planMarkers: L.LayerGroup;
  peakMarkers: L.LayerGroup;
  // Astronaut id -> marker, placed from the simulate reply.
  crewMarkers: Record<"A" | "B", L.Marker>;
};

export function createMapView(container: HTMLElement): void {
  let view: MapView | null = null;
  const onState = (state: MissionState, previous: MissionState | null): void => {
    if (!state.meta) return;
    if (!view) {
      view = buildMap(container, state.meta, state.siteUrl);
      previous = null;
    }
    render(view, state, previous);
  };
  subscribe(onState);
  onState(getState(), null);
}

// ---- Build once, when meta.json is in the store ----

function buildMap(container: HTMLElement, meta: SiteMeta, siteUrl: string): MapView {
  const bounds = L.latLngBounds(gridBounds(meta));
  const sizeM = Math.max(meta.width, meta.height) * meta.cellSizeMeters;
  const margin = sizeM * PAN_MARGIN_FRACTION;
  const panBounds = L.latLngBounds([bounds.getSouth() - margin, bounds.getWest() - margin], [bounds.getNorth() + margin, bounds.getEast() + margin]);

  const map = L.map(container, {
    crs: L.CRS.Simple,
    minZoom: MAP_MIN_ZOOM,
    maxZoom: MAP_MAX_ZOOM,
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    maxBounds: panBounds,
    maxBoundsViscosity: 1,
    attributionControl: false,
    doubleClickZoom: false, // a double click would also add two stops
  });
  map.fitBounds(bounds);
  L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);

  const layers: Record<string, L.Layer> = {};

  // Basemap: the pipeline tile pyramid. Tile (0, 0) starts at the grid's north-west corner = map origin,
  // so the tiles line up with the grid exactly (coords.ts, tileZoomOffset).
  const offset = tileZoomOffset(meta.tiles.maxZoom, meta.tiles.metersPerPixelAtMaxZoom);
  layers.basemap = L.tileLayer(siteUrl + meta.tiles.path, {
    tileSize: meta.tiles.tileSize,
    zoomOffset: offset,
    minNativeZoom: meta.tiles.minZoom - offset,
    maxNativeZoom: meta.tiles.maxZoom - offset,
    minZoom: MAP_MIN_ZOOM,
    maxZoom: MAP_MAX_ZOOM,
    bounds, // no requests for tiles outside the grid
    noWrap: true,
    keepBuffer: 4,
  });

  // Overlays cover exactly the grid extent (docs/data-contract.md, section 1), one image pixel per cell.
  for (const overlay of meta.overlays) {
    layers[overlay.id] = L.imageOverlay(siteUrl + overlay.file, bounds, {
      opacity: OVERLAY_OPACITY,
      className: "pixelated",
      interactive: false,
    });
  }

  const envelopeCanvas = document.createElement("canvas");
  envelopeCanvas.width = meta.width;
  envelopeCanvas.height = meta.height;
  const envelopeOverlay = L.imageOverlay(EMPTY_IMAGE, bounds, { className: "pixelated envelope-overlay", interactive: false });
  layers.envelope = envelopeOverlay;

  // Route: a wide faint line under a thin bright one gives the glow. Not interactive, so clicks on it still add stops.
  const routeGlow = L.polyline([], { className: "route-glow", weight: 12, interactive: false });
  const routeCore = L.polyline([], { className: "route-core", weight: 3, interactive: false });
  const returnPath = L.polyline([], { className: "return-path", weight: 2, dashArray: "6 6", interactive: false });
  // Buddy injured: the rescuer's walk and carry, dotted so it reads apart from the dashed way home.
  const rescuePath = L.polyline([], { className: "rescue-path", weight: 4, dashArray: "1 8", lineCap: "round", interactive: false });
  // Solar particle alert: the way to the chosen full shelter, wide and solid so it is the first thing seen.
  const shelterPath = L.polyline([], { className: "shelter-path", weight: 6, interactive: false });
  layers.route = L.layerGroup([routeGlow, routeCore, returnPath, rescuePath, shelterPath]);
  // The terrain partial shelter of a solar particle alert (simulate shelters, kind "partial").
  const alertMarkers = L.layerGroup().addTo(map);

  // Solar particle alert banner over the top of the map. Text from the engine reply (render).
  const alertBanner = document.createElement("div");
  alertBanner.className = "alert-banner";
  alertBanner.setAttribute("role", "alert");
  alertBanner.hidden = true;
  container.parentElement?.append(alertBanner);

  const siteMarkers = buildSiteMarkers(meta);
  const planMarkers = L.layerGroup();
  // Science peaks from the last science plan (SciencePlan.candidates, kind "peak"). Not in meta.json.
  const peakMarkers = L.layerGroup();
  // B below A, so A stays readable when both stand on the same cell.
  // B can be dragged: it then stands on that cell instead of on the timeline (simulate bPosition).
  const crewB = L.marker([0, 0], { icon: divIcon("marker-crew marker-crew-b", "B", 22), draggable: true, keyboard: false, zIndexOffset: 850 });
  tooltip(crewB, "Crewmember B<br>Drag to place B anywhere");
  crewB.on("dragend", () => {
    const latlng = crewB.getLatLng();
    const cell = latLngToCell(meta, latlng.lat, latlng.lng);
    if (cell) {
      update({ bPosition: cell });
      return;
    }
    // Dropped outside the grid: put it back where the engine last placed B.
    const placed = getState().sim?.astronauts.find((item) => item.id === "B");
    if (placed) crewB.setLatLng(cellToLatLng(meta, placed.cell));
  });
  const crewMarkers = {
    A: L.marker([0, 0], { icon: divIcon("marker-crew", "A", 22), interactive: false, zIndexOffset: 900 }),
    B: crewB,
  };
  layers.markers = L.layerGroup([siteMarkers, peakMarkers, planMarkers]);

  map.on("click", (event: L.LeafletMouseEvent) => onMapClick(meta, event.latlng));
  map.on("contextmenu", (event: L.LeafletMouseEvent) => L.DomEvent.preventDefault(event.originalEvent));

  return {
    map,
    meta,
    layers,
    envelopeOverlay,
    envelopeCanvas,
    envelopeUrl: null,
    envelopeDrawId: 0,
    routeGlow,
    routeCore,
    returnPath,
    rescuePath,
    shelterPath,
    alertMarkers,
    alertBanner,
    planMarkers,
    peakMarkers,
    crewMarkers,
  };
}

function onMapClick(meta: SiteMeta, latlng: L.LatLng): void {
  const cell = latLngToCell(meta, latlng.lat, latlng.lng);
  if (!cell) return;
  const placing = getState().placing;
  if (placing === "start") {
    update({ start: cell, placing: "stop" });
    return;
  }
  if (placing === "end") {
    update({ end: cell, placing: "stop" });
    return;
  }
  addStop(cell);
}

function divIcon(className: string, text: string, sizePx: number): L.DivIcon {
  return L.divIcon({
    className: `map-marker ${className}`,
    html: `<span>${text}</span>`,
    iconSize: [sizePx, sizePx],
    iconAnchor: [sizePx / 2, sizePx / 2],
  });
}

// " (assumption)" when any of the named docs/assumptions.md constants has status ASSUMPTION (tooltips are plain HTML).
function assumptionNote(meta: SiteMeta, names: string[]): string {
  const anyAssumption = names.some((name) => meta.constants[name]?.status === "ASSUMPTION");
  return anyAssumption ? ` (assumption: ${names.join(", ")})` : "";
}

function tooltip(marker: L.Marker, text: string): L.Marker {
  return marker.bindTooltip(text, { direction: "top", offset: [0, -10], className: "map-tooltip" });
}

// Fixed points from meta.json: habitat, shelters, rover pickup zones, Curiosity stops.
function buildSiteMarkers(meta: SiteMeta): L.LayerGroup {
  const group = L.layerGroup();

  for (const zone of meta.roverPickupZones) {
    const marker = L.marker(cellToLatLng(meta, zone), { icon: divIcon("marker-pickup", "P", 20), keyboard: false });
    tooltip(marker, `Rover pickup zone ${zone.id}<br>Flat area ${Math.round(zone.areaM2)} m2 (pipeline rule, assumption)`).addTo(group);
  }

  for (const shelter of meta.shelters) {
    if (shelter.id === "habitat") continue; // drawn as the habitat marker below
    const full = shelter.kind === "full";
    const marker = L.marker(cellToLatLng(meta, shelter), {
      icon: divIcon(full ? "marker-shelter-full" : "marker-shelter-partial", shelter.id === "rover" ? "R" : "S", 26),
      keyboard: false,
      zIndexOffset: 200,
    });
    const kindText = full ? `Full radiation shelter${assumptionNote(meta, ["FULL_SHELTERS"])}` : "Partial shielding only";
    tooltip(marker, `${shelter.id}: ${kindText}${shelter.source ? `<br>${shelter.source}` : ""}`).addTo(group);
  }

  const habitat = L.marker(cellToLatLng(meta, meta.habitat), { icon: divIcon("marker-habitat", "H", 30), keyboard: false, zIndexOffset: 300 });
  tooltip(habitat, `Habitat: full radiation shelter${assumptionNote(meta, ["FULL_SHELTERS"])}, default start and end${meta.habitat.source ? `<br>${meta.habitat.source}` : ""}`).addTo(group);

  // Curiosity stops: click to add one as a route stop on its exact cell.
  const scienceNote = assumptionNote(meta, ["SCIENCE_WEIGHT_SULFATE", "SCIENCE_WEIGHT_RIDGE", "RIDGE_RADIUS_M"]);
  for (const waypoint of meta.waypoints) {
    const marker = L.marker(cellToLatLng(meta, waypoint), { icon: divIcon("marker-waypoint", waypoint.id, 26), zIndexOffset: 100 });
    tooltip(marker, `${waypoint.name}<br>Science value ${waypoint.scienceValue} of ${SCIENCE_VALUE_MAX}${scienceNote}<br>Click to add as a stop`);
    marker.on("click", () => addStop({ col: waypoint.col, row: waypoint.row }));
    marker.addTo(group);
  }
  return group;
}

// ---- Render: called on every store update, redraws only what changed ----

function render(view: MapView, state: MissionState, previous: MissionState | null): void {
  const changed = (key: keyof MissionState): boolean => previous === null || state[key] !== previous[key];

  if (changed("layers")) {
    for (const [id, layer] of Object.entries(view.layers)) {
      const visible = state.layers[id] === true;
      if (visible && !view.map.hasLayer(layer)) layer.addTo(view.map);
      if (!visible && view.map.hasLayer(layer)) view.map.removeLayer(layer);
    }
    // Keep the drawing order fixed whatever the toggle order: overlays, envelope, then route and markers.
    view.envelopeOverlay.bringToFront();
  }
  // During a contingency the map shows its envelope and action path instead of the normal ones.
  if (changed("envelope") || changed("contingency")) drawEnvelope(view, state.contingency ? state.contingency.envelope : state.envelope);
  if (changed("route")) drawRoute(view, state);
  if (changed("sim") || changed("contingency")) drawReturnPath(view, state);
  if (changed("contingency") || changed("scenario")) drawSepAlert(view, state);
  if (changed("stops") || changed("start") || changed("end") || changed("selectedStop")) drawPlanMarkers(view, state);
  if (changed("sciencePlan")) drawPeakMarkers(view, state);
  if (changed("sim") || changed("contingency") || changed("layers")) drawCrew(view, state);
  if (changed("placing")) view.map.getContainer().dataset.placing = state.placing;
}

// One canvas pixel per cell, then shown as an image overlay on the grid bounds.
function drawEnvelope(view: MapView, envelope: Envelope | null): void {
  view.envelopeDrawId += 1;
  const drawId = view.envelopeDrawId;
  if (!envelope) {
    setEnvelopeUrl(view, null);
    return;
  }
  const { width, height } = view.meta;
  const context = view.envelopeCanvas.getContext("2d");
  if (!context) return;
  const image = context.createImageData(width, height);
  const pixels = image.data;
  for (let i = 0; i < envelope.mask.length; i++) {
    const level = envelope.mask[i];
    if (level === 0) continue; // transparent: cannot return
    const rgba = level === 2 ? ENVELOPE_SAFE_RGBA : ENVELOPE_RESERVE_RGBA;
    pixels[i * 4] = rgba[0];
    pixels[i * 4 + 1] = rgba[1];
    pixels[i * 4 + 2] = rgba[2];
    pixels[i * 4 + 3] = rgba[3];
  }
  context.putImageData(image, 0, 0);
  // toBlob encodes off the main path. A newer draw may finish first: only the newest one is shown.
  view.envelopeCanvas.toBlob((blob) => {
    if (!blob || drawId !== view.envelopeDrawId) return;
    setEnvelopeUrl(view, URL.createObjectURL(blob));
  }, "image/png");
}

function setEnvelopeUrl(view: MapView, url: string | null): void {
  view.envelopeOverlay.setUrl(url ?? EMPTY_IMAGE);
  if (view.envelopeUrl) URL.revokeObjectURL(view.envelopeUrl);
  view.envelopeUrl = url;
}

function drawRoute(view: MapView, state: MissionState): void {
  const points = state.route ? state.route.path.map((cell) => cellToLatLng(view.meta, cell)) : [];
  view.routeGlow.setLatLngs(points);
  view.routeCore.setLatLngs(points);
}

// The engine's action path for crew A (simulate actionPath): the way home with no event, else the way to the shelter
// or the rescue walk and carry.
function drawReturnPath(view: MapView, state: MissionState): void {
  const sim = state.contingency ?? state.sim;
  const points = sim ? sim.actionPath.map((cell) => cellToLatLng(view.meta, cell)) : [];
  const scenario = sim ? sim.scenario : "none";
  view.returnPath.setLatLngs(scenario === "none" ? points : []);
  view.rescuePath.setLatLngs(scenario === "buddy_injured" ? points : []);
  view.shelterPath.setLatLngs(scenario === "sep_event" ? points : []);
}

// Banner and terrain partial shelter marker during a solar particle alert.
function drawSepAlert(view: MapView, state: MissionState): void {
  view.alertMarkers.clearLayers();
  const alert = state.scenario === "sep_event" && state.contingency?.scenario === "sep_event" ? state.contingency : null;
  view.alertBanner.hidden = alert === null;
  if (!alert) return;

  // Whole minutes, rounded like formatDuration in the panels, so the banner and the shelter table agree.
  const hasShelter = alert.actionTargetId !== null && alert.actionPath.length > 0;
  view.alertBanner.textContent = hasShelter
    ? `Solar particle alert - go to shelter: ${Math.round(alert.actionTimeS / SECONDS_PER_MINUTE)} min (${alert.actionTargetId})`
    : "Solar particle alert - no full shelter reachable on foot";

  for (const option of alert.shelters) {
    if (option.kind !== "partial") continue;
    const marker = L.marker(cellToLatLng(view.meta, option.cell), { icon: divIcon("marker-shelter-partial", "T", 24), keyboard: false, zIndexOffset: 600 });
    const openSky = option.openSkyShare === null ? "" : `, open sky ${Math.round(option.openSkyShare * 100)}%`;
    const note = assumptionNote(view.meta, ["SHIELD_PARTIAL_MAX_SKY", "TERRAIN_SHIELD_MODEL"]);
    tooltip(marker, `Terrain: partial shielding only${openSky}${note}`).addTo(view.alertMarkers);
  }
}

function drawPeakMarkers(view: MapView, state: MissionState): void {
  view.peakMarkers.clearLayers();
  const plan = state.sciencePlan;
  if (!plan) return;
  const scienceNote = assumptionNote(view.meta, ["SCIENCE_WEIGHT_SULFATE", "SCIENCE_WEIGHT_RIDGE", "RIDGE_RADIUS_M", "SCIENCE_PEAK_COUNT"]);
  for (const peak of plan.candidates) {
    if (peak.kind !== "peak") continue;
    const marker = L.marker(cellToLatLng(view.meta, peak), { icon: divIcon("marker-peak", peak.id, 26), zIndexOffset: 90 });
    const text = `Science peak ${peak.id}: no Curiosity image<br>Science value ${peak.scienceValue} of ${SCIENCE_VALUE_MAX}${scienceNote}<br>Click to add as a stop`;
    tooltip(marker, text);
    marker.on("click", () => addStop({ col: peak.col, row: peak.row }));
    marker.addTo(view.peakMarkers);
  }
}

function drawPlanMarkers(view: MapView, state: MissionState): void {
  view.planMarkers.clearLayers();
  const meta = view.meta;

  if (state.start) {
    const marker = L.marker(cellToLatLng(meta, state.start), { icon: divIcon("marker-start", "S", 24), zIndexOffset: 700, keyboard: false });
    tooltip(marker, `Start ${state.start.col},${state.start.row}`).addTo(view.planMarkers);
  }
  if (state.end) {
    const marker = L.marker(cellToLatLng(meta, state.end), { icon: divIcon("marker-end", "E", 24), zIndexOffset: 700, keyboard: false });
    tooltip(marker, `End ${state.end.col},${state.end.row}`).addTo(view.planMarkers);
  }

  state.stops.forEach((stop, index) => {
    const selected = state.selectedStop === index;
    const marker = L.marker(cellToLatLng(meta, stop), {
      icon: divIcon(selected ? "marker-stop selected" : "marker-stop", String(index + 1), 26),
      draggable: true,
      zIndexOffset: 800,
    });
    tooltip(marker, `Stop ${index + 1} (cell ${stop.col},${stop.row})<br>Drag to move, right-click to delete`);
    marker.on("click", () => update({ selectedStop: index }));
    marker.on("contextmenu", (event: L.LeafletMouseEvent) => {
      L.DomEvent.preventDefault(event.originalEvent);
      removeStop(index);
    });
    marker.on("dragend", () => {
      const latlng = marker.getLatLng();
      const cell: Cell | null = latLngToCell(meta, latlng.lat, latlng.lng);
      if (!cell) {
        marker.setLatLng(cellToLatLng(meta, stop)); // dropped outside the grid: put it back
        return;
      }
      moveStop(index, cell);
    });
    marker.addTo(view.planMarkers);
  });
}

function drawCrew(view: MapView, state: MissionState): void {
  for (const id of ["A", "B"] as const) {
    const marker = view.crewMarkers[id];
    const astronaut = state.sim ? state.sim.astronauts.find((item) => item.id === id) : undefined;
    const visible = astronaut !== undefined && state.layers.markers === true;
    if (!visible) {
      marker.remove();
      continue;
    }
    marker.setLatLng(cellToLatLng(view.meta, astronaut.cell));
    if (!view.map.hasLayer(marker)) marker.addTo(view.map);
    // Status from the buddy-injured reply; positions are the same in both replies.
    const status = state.contingency?.astronauts.find((item) => item.id === id)?.status ?? "ok";
    const element = marker.getElement();
    element?.classList.toggle("marker-injured", status === "injured");
    element?.classList.toggle("marker-rescuer", status === "rescuer");
  }
}
