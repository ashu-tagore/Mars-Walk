# Constants and Assumptions

Every constant used in code lives here. Code must use these names.
Status:
- SOURCED = published value, cite in the UI tooltip.
- ASSUMPTION = our choice, show an "assumption" tag in the UI. Must be adjustable in settings where noted.
- DEFINITION = a unit conversion, not a model value.

Every row with a NAME in capitals is copied by the pipeline into meta.json `constants` (docs/data-contract.md, section 2).
Tests in /pipeline and /engine check that each constant in code has a row here with the same value.

Each SOURCED value was checked against docs/research.md on 2026-11-14. Changes after that check are marked "(changed 2026-11-14)"; the project owner chose each one.

## Environment

| Name | Value | Status | Source / reason |
|---|---|---|---|
| MARS_GRAVITY | 3.73 m/s^2 | SOURCED | NASA Mars Fact Sheet, mean surface gravity (updated 2025). Was 3.71 (2007 edition) (changed 2026-11-14) |
| ONE_WAY_LIGHT_TIME_MIN | 3 to 22 min | SOURCED | Light time over the Earth-Mars distance, 54.6 to 401 million km. Was 4 to 24 (changed 2026-11-14) |
| ROUTING_CELL_SIZE_M | 3.0 | ASSUMPTION | HiRISE DTM effective resolution is about 3x its 1 m post spacing; 1 m slopes are noise |

## EVA limits

| Name | Value | Status | Source / reason |
|---|---|---|---|
| MAX_WALK_RADIUS_M | 2000 | SOURCED | NASA EVA-EXP-0042 Rev B (2020), p. 38: traverses up to 2 km away from the lander |
| MAX_SLOPE_DEG | 20 | SOURCED | NASA EVA-EXP-0042 Rev B (2020), p. 38: walking up/down/across a slope of up to 20 deg |
| CAUTION_SLOPE_DEG | 15 | SOURCED | Pena-Asensio et al. 2023, Acta Astronautica (automated Artemis traverses): slopes limited to 15 deg. Not a NASA limit |
| RESCUE_DISTANCE_M | 2000 | SOURCED | NASA Lunar Rescue System webinar (NTRS 20250000528, 2025): one crewmember transports an incapacitated crewmember up to 2 km, slopes up to 20 deg |
| EVA_DURATION_H | 6 (range 4 to 8) | SOURCED | NASA EVA-EXP-0042 Rev B (2020), p. 29: EVAs between 4 and 8 hours (6 +/- 2). Adjustable. |
| PEAK_METABOLIC_KJ_PER_H | 2110 | SOURCED | Apollo PLSS design peak, 2000 BTU/h |
| AVG_METABOLIC_KJ_PER_H | 1266 | SOURCED | Apollo PLSS design average, 1200 BTU/h (NASA technical report, NTRS 19720019467). Was 1688 = 1600 BTU/h, a press value (changed 2026-11-14) |
| STOP_DWELL_MIN | 20 | SOURCED | Apollo 12, second EVA: seven major stops, "On average, they had about twenty minutes at each location" (Apollo Lunar Surface Journal, docs/research.md, section 2.3). One traverse, not a rule. Adjustable. (project owner, 2026-11-14) |
| STATION_WORK_W | 280 | SOURCED | Apollo geological station activity, 244 kcal/h = 284 W (Moore, NTRS 19910001262, p. 2, citing Waligora and Horrigan 1975) |
| RESERVE_FRACTION | 0.20 | ASSUMPTION | Safety margin kept unused on return. Adjustable. |
| BUDDY_MAX_SEPARATION_M | 100 | ASSUMPTION | No Mars rule published. Adjustable. |
| CAUTION_SLOPE_PENALTY | 1.5 | ASSUMPTION | Extra cost multiplier for 15-20 deg cells |

## Body and load

| Name | Value | Status | Source / reason |
|---|---|---|---|
| ASTRONAUT_MASS_KG | 80 | ASSUMPTION | Typical body mass |
| SUIT_AND_GEAR_MASS_KG | 120 | ASSUMPTION | Suit + life support + tools. No Mars suit exists yet. Adjustable. NASA designs its lunar rescue device for up to 342 kg (755 lb) crew + suit; the project owner kept 80 + 120 = 200 kg (2026-11-14) |
| WALK_SPEED_M_PER_S | 1.1 | SOURCED | Norcross et al., NASA/TP-2010-216115, p. 56: site-to-site walking 1.1 to 1.4 m/s (lunar). Lower end chosen. Was 0.9, no source found (changed 2026-11-14) |
| RESCUE_SPEED_M_PER_S | 0.5 | ASSUMPTION | Slower pace while carrying a crewmember. Adjustable. |

## Metabolic model (Santee et al. load-carriage model)

Santee, Allison, Blanchard and Small, Aviat Space Environ Med 2001; 72(6): 562-6. Checked on 2026-11-14: the equations below are identical to
Johnson et al., AIAA SPACE 2010, p. 7, Table 2 (docs/research.md, section 2.5). The original paper was not accessible.

Symbols: M = total mass (body + suit + load) in kg, v = speed in m/s, theta = signed slope angle of the edge (positive = uphill), g = MARS_GRAVITY.

```
W_level = (3.28 * M + 71.1) * (0.661 * v * cos(theta) + 0.115)
W_up    = 3.5 * M * g * v * sin(theta)                              (theta > 0)
W_down  = 2.4 * M * g * v * sin(theta) * 0.3 ** (abs(theta_deg) / 7.65)   (theta < 0, result is negative)
W_total = max(W_level + W_slope, W_level * 0.5)
```

| Name | Value | Status | Source / reason |
|---|---|---|---|
| SANTEE_LEVEL_MASS_COEF | 3.28 | SOURCED | Santee et al. 2001, W_level mass coefficient (W/kg), via Johnson et al. 2010, Table 2 |
| SANTEE_LEVEL_OFFSET_W | 71.1 | SOURCED | Santee et al. 2001, W_level offset (W), via Johnson et al. 2010, Table 2 |
| SANTEE_LEVEL_SPEED_COEF | 0.661 | SOURCED | Santee et al. 2001, W_level speed coefficient (s/m), via Johnson et al. 2010, Table 2 |
| SANTEE_LEVEL_BASE | 0.115 | SOURCED | Santee et al. 2001, W_level constant term, via Johnson et al. 2010, Table 2 |
| SANTEE_UPHILL_COEF | 3.5 | SOURCED | Santee et al. 2001, W_up coefficient, via Johnson et al. 2010, Table 2 |
| SANTEE_DOWNHILL_COEF | 2.4 | SOURCED | Santee et al. 2001, W_down coefficient, via Johnson et al. 2010, Table 2 |
| SANTEE_DOWNHILL_DECAY_BASE | 0.3 | SOURCED | Santee et al. 2001, W_down decay base, via Johnson et al. 2010, Table 2 |
| SANTEE_DOWNHILL_DECAY_DEG | 7.65 | SOURCED | Santee et al. 2001, W_down decay angle (deg), via Johnson et al. 2010, Table 2 |
| SANTEE_MIN_LEVEL_FRACTION | 0.5 | ASSUMPTION | Floor W_total >= W_level * 0.5. Not in the source: it stops steep downhill edges from giving near-zero cost |
| METABOLIC_MODEL_AT_MARS_GRAVITY | Santee et al. 2001 with g = MARS_GRAVITY | ASSUMPTION | The model was fitted on Earth (treadmill, about 1.34 m/s). Limited validation at reduced gravity (docs/research.md, section 2.5) |

- The floor `W_level * 0.5` is an ASSUMPTION: it stops steep downhill edges from giving near-zero cost.
- Edge energy (J) = W_total * (surface_distance / v), where surface_distance = horizontal_distance / cos(theta).
- Rescue mode: M = rescuer mass + incapacitated astronaut mass (both with suits). v = RESCUE_SPEED_M_PER_S.
- The original model was fitted for Earth. Applying it at Mars gravity is an ASSUMPTION.

## Radiation

| Name | Value | Status | Source / reason |
|---|---|---|---|
| GCR_DOSE_MSV_PER_DAY | 0.64 (+/- 0.12) | SOURCED | Hassler et al., Science 2014 (Curiosity RAD) |
| SEP_MAY2024_TOTAL_UGY | 8100 | SOURCED | NASA release, June 2024: about 8,100 micrograys beside Curiosity for the 20 May 2024 event (a total, not a rate) |
| SEP_ARRIVAL | tens of minutes | SOURCED | NASA release, June 2024: the charged particles reached Mars in tens of minutes |
| SEP_SHELTER_TARGET_MIN | 30 | ASSUMPTION | Warn when the crew needs longer than this to reach a full shelter. 30 min = the lower end of the 30 to 60 min particle onset after the 2013-2014 flares (docs/research.md, section 2.6). SEP_ARRIVAL gives no exact number. Adjustable. (project owner, 2026-11-14) |
| TERRAIN_SHIELD_MODEL | zenith-weighted sky view | ASSUMPTION | Low-angle particles cross more atmosphere, so overhead sky matters most |
| FULL_SHELTERS | habitat, rover | ASSUMPTION | Terrain is partial shielding only |

## Data limits (show in the UI "About the data" panel)

| Item | Value | Source |
|---|---|---|
| Boulder detection floor | ~1.5 m | Hood et al. 2022 (MBARS, after Golombek et al. 2008): boulders wider than about 1.5 m cast detectable shadows in nearly all HiRISE images |
| DEM fallback | CTX/HRSC where HiRISE stereo is missing | USGS MSL Gale DEM metadata |
| Contingency recovery | rover pickup zone = flat cell (< ROVER_PICKUP_MAX_SLOPE_DEG = 5 deg, ASSUMPTION) reachable on foot from the habitat. Rover driving access is not modeled. | ASSUMPTION |

## Pipeline (Phase 1, added 2026-11-14)

Values in pipeline/constants.py. prepare.py copies them into meta.json `constants`, so the app can tag each ASSUMPTION.
How a value was measured on the real data is in the reason column. Test grids in pipeline/tests are fixtures, not data.

### Terrain cost (terrain_cost.bin)

| Name | Value | Status | Source / reason |
|---|---|---|---|
| ROUGHNESS_DETREND_SIGMA_M | 2.0 | ASSUMPTION | Gaussian sigma removed from the 1 m DEM before roughness is measured, so the cell slope does not count as roughness |
| ROUGHNESS_COST_PER_M | 0.5 | ASSUMPTION | Multiplier = 1 + this * roughness RMS (m). AOI median RMS is about 0.15 m, so the median cell costs about 7% more than smooth ground. No published Mars value. Adjustable. |
| ROUGHNESS_MAX_FACTOR | 1.5 | ASSUMPTION | Cap on the roughness factor |
| BOULDER_COST_FACTOR | 1.3 | ASSUMPTION | Extra cost for a cell with a detected boulder shadow (walk around or over blocks). Adjustable. |

### Boulder shadows (orthophoto, 0.5 m pixels)

| Name | Value | Status | Source / reason |
|---|---|---|---|
| BOULDER_LOCAL_WINDOW_M | 25 | ASSUMPTION | Window for the local mean brightness, so dark sand does not count as shadow |
| BOULDER_SHADOW_DARKNESS | 0.6 | ASSUMPTION | Shadow pixel = darker than 0.6 x local mean. Checked by eye on two 200 m crops. |
| BOULDER_MIN_SHADOW_AREA_M2 | 1.0 | ASSUMPTION | 4 pixels. Matches the ~1.5 m detection floor (see Data limits) |
| BOULDER_MAX_SHADOW_AREA_M2 | 25 | ASSUMPTION | Larger dark blobs are outcrop or scarp shadows |
| BOULDER_MAX_ELONGATION | 2.5 | ASSUMPTION | Ratio of principal axes. Build plan: keep compact roundish blobs, reject long thin ridge shadows |

### Terrain radiation shielding (shield.bin)

| Name | Value | Status | Source / reason |
|---|---|---|---|
| SHIELD_AZIMUTHS | 16 | ASSUMPTION | Directions used to find the horizon |
| SHIELD_SEARCH_RADIUS_M | 300 | ASSUMPTION | Horizon search distance. Terrain outside the AOI counts as open sky. Open sky share per direction = cos^2(horizon angle) (TERRAIN_SHIELD_MODEL). |

### DEM quality (dem_quality.bin)

The test (decision of the project owner, 2026-11-14): for each 1 m pixel, coherence = |mean of signed across-column curvature| / mean of |across-column curvature|, both over a run down the column.
Stripes that follow the DEM pixel columns keep their sign and give a high value. Real terrain does not.
Calibrated on the artifact seen in the hillshade (rows 0 to 180, columns 2900 to 3000 of dem_aoi.tif): median score there 0.46, which only 1.3% of the AOI exceeds.
With the values below the test flags 75% of that artifact block, 51% of the second Phase 0 spot (rows 1900 to 2100) and 2.0% of the AOI in total.

| Name | Value | Status | Source / reason |
|---|---|---|---|
| DEM_QUALITY_COLUMN_RUN_M | 151 | ASSUMPTION | Run length down a column. Real ridges drift off a pixel column within this distance |
| DEM_QUALITY_WINDOW_M | 30 | ASSUMPTION | Averaging window of the coherence score |
| DEM_QUALITY_COHERENCE_MIN | 0.42 | ASSUMPTION | Threshold, just below the artifact median (0.46) |
| DEM_QUALITY_MIN_AREA_M2 | 1800 | ASSUMPTION | 200 cells. Smaller flagged patches are dropped as noise |

### Science value (science_val.bin)

| Name | Value | Status | Source / reason |
|---|---|---|---|
| SCIENCE_WEIGHT_SULFATE | 0.5 | ASSUMPTION | Weight of normalized CRISM SINDEX2 (band 42 of the summary-parameter product, read from the label) |
| SCIENCE_WEIGHT_RIDGE | 0.5 | ASSUMPTION | Weight of the boxwork ridge score |
| RIDGE_RADIUS_M | 15 | ASSUMPTION | Ridge score = height above the mean of the cells within this radius (0 if below) |
| SCIENCE_NORMALIZE_LOW_PERCENTILE | 2 | ASSUMPTION | Each part is stretched 0..1 between these AOI percentiles |
| SCIENCE_NORMALIZE_HIGH_PERCENTILE | 99.5 | ASSUMPTION | Same. Was 98: the top stops then all scored 255 and could not be ranked (project owner chose 99.5 on 2026-11-14) |
| SCIENCE_STOP_COUNT | 12 | ASSUMPTION | Maximum stops in meta.json waypoints. Stops are real Curiosity stops (sols aoi_sol_min to aoi_sol_max), highest science value first. With the spacing below, 7 fit on the 2025 track |
| SCIENCE_STOP_MIN_SPACING_M | 150 | ASSUMPTION | Minimum distance between candidate stops, and from the habitat |

### Habitat, rover and pickup zones (meta.json points)

| Name | Value | Status | Source / reason |
|---|---|---|---|
| ROVER_PICKUP_MAX_SLOPE_DEG | 5 | ASSUMPTION | Flat cell for a rover pickup (Data limits, "Contingency recovery"). Also used for the habitat site |
| ROVER_PICKUP_MIN_AREA_M2 | 900 | ASSUMPTION | Flat zone must be at least 30 m x 30 m |
| ROVER_PICKUP_MAX_COUNT | 6 | ASSUMPTION | Largest zones first |
| ROVER_PICKUP_MIN_SPACING_M | 300 | ASSUMPTION | Spread the zones over the area |
| HABITAT_MIN_FLAT_AREA_M2 | 2500 | ASSUMPTION | Habitat = most interior cell of the flat zone (>= 50 m x 50 m) nearest the AOI center. The site YAML can override it (habitat_lat, habitat_lon) |

Rover parking (a full shelter): the pickup zone nearest the middle of the science stops (ASSUMPTION). The site YAML can override it (rover_lat, rover_lon).
Pickup zones and stops must be reachable on foot from the habitat, using the engine's edge rules: 8-connected passable cells,
no edge steeper than MAX_SLOPE_DEG, and NO_CORNER_CUTTING (section "Engine"). The pipeline uses NO_CORNER_CUTTING too. Rover driving access is not modeled.

### Output files (added 2026-11-15, REVIEW.md F-03)

| Name | Value | Status | Source / reason |
|---|---|---|---|
| TILE_JPEG_QUALITY | 85 | ASSUMPTION | JPEG quality of the basemap tiles: a balance of file size (offline cache) and detail. Display only |
| DEM_EAST_STRIP_M | 100 | ASSUMPTION | Width of the east strip where the Phase 0 check saw stripe and seam signs (columns about 2900 to 3000, docs/datasets.md, section 1). Used only to report the DEM quality test result in meta.json `notes` |

## Engine (Phase 2, added 2026-11-14, decisions of the project owner)

Values in engine/src/constants.ts.

| Name | Value | Status | Source / reason |
|---|---|---|---|
| EVA_ENERGY_BUDGET_J | EVA_DURATION_H * AVG_METABOLIC_KJ_PER_H * 1000 = 7.596e6 J | ASSUMPTION (derived from two SOURCED values) | Walk-back budget. Using the design average rate as a whole-EVA energy budget is our choice. Adjustable with setParams. |
| NO_CORNER_CUTTING | true | ASSUMPTION | A diagonal move is allowed only when both side neighbours are passable, so a route cannot slip diagonally through an impassable band |

- Caution penalty: terrain_cost.bin already contains CAUTION_SLOPE_PENALTY (docs/data-contract.md, section 1). The engine does not apply it again.
  The engine adds one edge rule: an edge whose signed slope is steeper than MAX_SLOPE_DEG is impassable.
- Route time and energy = walking + STOP_DWELL_MIN at each stop (not at the start or end), spent at STATION_WORK_W.
  Was walking only (dwell 0); changed by the project owner on 2026-11-14 once a published value was found.
- Science planner, contingency simulator and rescue feasibility: rules in docs/data-contract.md, section 4.1 (Phase 4).
  A rescue may use the reserve (feasible within the full EVA_ENERGY_BUDGET_J). The carry path is limited to RESCUE_DISTANCE_M,
  for the rescue targets and for the rescue safe area on the map (project owner, 2026-11-14).
- Walk-back mask per cell (return cost and time from Dijkstra over reversed edges): 2 if usedJ + returnJ <= EVA_ENERGY_BUDGET_J * (1 - RESERVE_FRACTION),
  1 if it fits within EVA_ENERGY_BUDGET_J, else 0. Also 0 if elapsedS + returnS > EVA_DURATION_H.
| Name | Value | Status | Source / reason |
|---|---|---|---|
| TURN_BACK_MODEL | remaining energy spent at STATION_WORK_W while the crew stays at `position` | ASSUMPTION | Formula below |

- Turn-back time (ASSUMPTION: remaining energy is spent at STATION_WORK_W while the crew stays at `position`):
  energySlack = EVA_ENERGY_BUDGET_J * (1 - RESERVE_FRACTION) - usedJ - returnJ(position);
  timeSlack = EVA_DURATION_H * 3600 - elapsedS - returnS(position);
  turnBackAtS = elapsedS + max(0, min(timeSlack, energySlack / STATION_WORK_W)).
- Route verdict:
  - NO_GO: no path; or energy > EVA_ENERGY_BUDGET_J; or time > EVA_DURATION_H; or a route cell is farther than MAX_WALK_RADIUS_M from the habitat.
  - CAUTION: an edge slope above CAUTION_SLOPE_DEG; or a demQuality = 1 cell; or energy > EVA_ENERGY_BUDGET_J * (1 - RESERVE_FRACTION).
  - GO: none of the above.

## Units (added 2026-11-14)

| Name | Value | Status | Source / reason |
|---|---|---|---|
| SECONDS_PER_HOUR | 3600 | DEFINITION | Unit conversion |
| SECONDS_PER_MINUTE | 60 | DEFINITION | Unit conversion |
| MINUTES_PER_HOUR | 60 | DEFINITION | Unit conversion (SECONDS_PER_HOUR / SECONDS_PER_MINUTE) (added 2026-11-15) |
| JOULES_PER_MJ | 1e6 | DEFINITION | Unit conversion (added 2026-11-15) |
| METERS_PER_KM | 1000 | DEFINITION | Unit conversion (added 2026-11-15) |
| SCIENCE_VALUE_MAX | 255 | DEFINITION | Top of the science value scale: science_val.bin and waypoint scienceValue are uint8 0 to 255 (docs/data-contract.md, section 1) (added 2026-11-15) |

## App display (added 2026-11-15, REVIEW.md F-03)

Values in /app. They set how the map and panels look and respond. They do not change any computed number.

| Name | Value | Status | Source / reason |
|---|---|---|---|
| TIMELINE_STEP_S | 60 | ASSUMPTION | EVA time slider step: one minute. Display choice |
| OVERLAY_OPACITY | 0.75 | ASSUMPTION | Opacity of the meta.json overlays, so the basemap stays visible below. Display choice |
| MAP_MIN_ZOOM | -3 | ASSUMPTION | Leaflet zoom z draws 2^z pixels per meter: -3 shows the 3 km site in about 375 px. Display choice |
| MAP_MAX_ZOOM | 4 | ASSUMPTION | 16 px per meter, past the 0.5 m orthophoto pixels. Display choice |
| PAN_MARGIN_FRACTION | 0.25 | ASSUMPTION | Share of the site size the user may pan past the edge. Display choice |
