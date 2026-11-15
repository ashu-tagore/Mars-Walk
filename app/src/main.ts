// Wiring only: build the panels and the map, open the site, register the offline service worker.

import "./style.css";
import { registerSW } from "virtual:pwa-register";
import { createAbout } from "./about";
import { openSite } from "./engine-client";
import { createHelmet } from "./helmet";
import { createMapView } from "./map-view";
import { createPanels } from "./panels";
import { update } from "./store";

const SITE_ID = "gale_boxwork";

function byId(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!node) throw new Error(`index.html has no #${id}`);
  return node;
}

createPanels({ header: byId("header"), left: byId("left-panel"), right: byId("right-panel"), profile: byId("profile") });
createMapView(byId("map"));
createHelmet(document.body);
createAbout(document.body);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") update({ placing: "stop", helmet: false, aboutOpen: false });
});

// Absolute URL: the worker resolves relative URLs against its own script location, not the page.
const siteUrl = new URL(`${import.meta.env.BASE_URL}sites/${SITE_ID}/`, window.location.href).href;
void openSite(siteUrl);

// The dev server has no service worker. In a build, the worker precaches the app and the whole site folder.
// onOfflineReady fires once, after the first full precache. On later visits an active worker means the cache is there.
if (!import.meta.env.DEV) {
  registerSW({
    immediate: true,
    onOfflineReady: () => update({ offlineReady: true }),
    onRegisteredSW: (_url, registration) => {
      if (registration?.active) update({ offlineReady: true });
    },
  });
}
