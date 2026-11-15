# Boxwork EVA Navigator

An offline planner for a two-person walk on Mars ("Marswalk") at the boxwork area of Mount Sharp, Gale Crater.
NASA Space Apps 2026, challenge "Interplanetary Survival Guide: Martian Map".

It tells two astronauts which science stops are worth the energy, which route to walk, when they must turn back,
and what to do if a solar storm starts or one of them is injured. Everything runs in the browser, with no server.

## Status

| Part | State |
|---|---|
| `/pipeline` (Python) | Built. Turns real NASA data into a 3 m routing grid, map tiles and layers. |
| `/engine` (TypeScript, Web Worker) | Built. Directional energy routing, walk-back area, shelter times, science planner, contingency simulator. |
| `/app` (TypeScript, Vite, Leaflet) | Core built (Phase 3): map with orthophoto and data layers, stops, route, walk-back area with EVA time slider, energy budget, route profile. Works offline after the first load. Contingency simulator, helmet mode and voice come next (Phase 4). |

## How it works

- **Terrain:** a 1 m HiRISE elevation model, averaged to 3 m cells. Slopes above 20 deg cannot be walked; 15 to 20 deg cost more.
- **Energy:** each step costs energy from the Santee et al. (2001) load-carriage model at Mars gravity. Walking uphill costs more
  than walking downhill, so the way out and the way back have different costs.
- **Walk-back area:** from every cell, the energy and time needed to get back to the habitat. It shrinks as the walk goes on.
- **Buddy rescue:** one astronaut carries the other (both masses as load, at a slower pace), at most 2 km (NASA lunar rescue design).
- **Radiation:** only the habitat and the rover are full shelters. Terrain gives partial shielding only.

Every constant is listed in [docs/assumptions.md](docs/assumptions.md) as SOURCED (with its source) or ASSUMPTION (our choice).
The app shows a grey "assumption" tag next to every value that uses an ASSUMPTION constant. Its tooltip names the constants
(read from the `constants` table in `meta.json`).

## Setup and commands

Python 3.11 is required for the pipeline.

```
cd pipeline
uv venv --python 3.11 .venv
uv pip install -r requirements.txt
.venv\Scripts\activate            (Windows)   or   source .venv/bin/activate   (macOS/Linux)

python fetch_data.py --config ../sites/gale_boxwork.yaml    download the data (data/raw/, listed in data/manifest.json)
python prepare.py --config ../sites/gale_boxwork.yaml       build app/public/sites/gale_boxwork/
python -m pytest                                            pipeline tests (bare pytest fails on Windows in a uv venv)

cd ../engine
npm install
npm run typecheck                                           engine type check (source and tests)
npm test                                                    engine tests

cd ../app
npm install
npm run dev                                                 app at http://localhost:5173 (no offline cache in dev)
npm test                                                    app tests (grid cell <-> map coordinates)
npm run build                                               type-check and build to app/dist/
npm run preview                                             serve the build at http://localhost:4173, with the offline cache
```

The app reads the pipeline output in `app/public/sites/gale_boxwork/` and runs the engine in a Web Worker
(`engine/src/worker.ts`, bundled by Vite). There is no server and no runtime call to an external API.

### Using the app

- Click the map, or a Curiosity stop marker (s1 to s7), to add a stop. Drag a stop to move it. Right-click a stop to delete it.
- "Set start" and "Set end", then click the map. By default the walk starts and ends at the habitat. Esc cancels.
- Move the EVA timeline slider: the engine places crew A on the plan at that time and redraws the walk-back area.
  Green: can return and keep the reserve. Amber: can return only by using the reserve. Clear: cannot return in time or energy.
  On this 3 km site the return energy from any reachable cell is small, so the time limit (EVA_DURATION_H) shrinks the area most,
  in the last hour of the EVA.

## Deploy (GitHub Pages)

The workflow `.github/workflows/deploy.yml` runs the engine tests and the app tests, builds `/app` with the base path
`/<repo-name>/`, and deploys `app/dist` to GitHub Pages on every push to `main`.

1. Create a GitHub repository and push this folder to its `main` branch. `app/public/sites/` (about 31 MB) must be committed;
   `data/raw/` stays out (it is gitignored).
2. In the repository: Settings > Pages > Build and deployment > Source: "GitHub Actions".
3. Push to `main`, or run the workflow by hand (Actions > "Deploy app to GitHub Pages" > Run workflow).
4. The site is at `https://<owner>.github.io/<repo-name>/`. The URL is also on the workflow run page.
5. Offline check: open the URL in a Chrome or Edge private window and wait until the header badge says "offline ready"
   (the service worker has then stored the app and all 795 site files, about 30 MB). Turn the network off
   (DevTools > Network > Offline, or disconnect), reload, and use the app. Firefox private windows do not run service workers,
   so the offline check does not work there.

For a user site (`<owner>.github.io` repository) set `VITE_BASE: /` in the workflow. To build for another path by hand:
`VITE_BASE=/some/path/ npm run build` (in Git Bash on Windows, add `MSYS_NO_PATHCONV=1` before it, or the path is rewritten).

## Documentation

- [docs/assumptions.md](docs/assumptions.md): every constant, with its source or the "assumption" label

## Data credits

HiRISE: NASA/JPL-Caltech/UArizona. DEM and orthophoto mosaics: Calef and Parker (2016), USGS Astrogeology.
THEMIS: NASA/JPL-Caltech/ASU. CRISM: NASA/JHU-APL. Curiosity images and RAD: NASA/JPL-Caltech/SwRI.

The credit line of each downloaded file is in `data/manifest.json`. The `sources` list in `meta.json` holds the credits
for the app's "About the data" panel. Astronaut positions and the solar storm alert are simulated; the storm uses values
from the real May 2024 event measured by Curiosity's RAD instrument.

## Use of AI

Code, tests and documentation in this repository were written with Claude Code (Anthropic), an AI coding assistant,
under the direction of the project owner. The design decisions are recorded in the docs as "decision of the project owner".
