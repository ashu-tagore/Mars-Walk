// Every constant the engine uses. Each one has a row in docs/assumptions.md with the same name and value
// (checked by test/constants.test.ts).
// SOURCED values cite the source given there. ASSUMPTION values are our choice and the UI must tag them.

// ---- Environment ----

// SOURCED: NASA Mars Fact Sheet, mean surface gravity (updated 2025).
export const MARS_GRAVITY = 3.73; // m/s^2

// ASSUMPTION: HiRISE DTM effective resolution is about 3x its 1 m post spacing.
export const ROUTING_CELL_SIZE_M = 3.0;

// ---- EVA limits ----

// SOURCED: NASA EVA-EXP-0042 Rev B (2020), p. 38: traverses up to 2 km away from the lander.
export const MAX_WALK_RADIUS_M = 2000;

// SOURCED: NASA EVA-EXP-0042 Rev B (2020), p. 38: walking up/down/across a slope of up to 20 deg.
export const MAX_SLOPE_DEG = 20;

// SOURCED: Pena-Asensio et al. 2023, Acta Astronautica: slopes limited to 15 deg. Not a NASA limit.
export const CAUTION_SLOPE_DEG = 15;

// ASSUMPTION: extra cost for 15-20 deg cells. Already inside terrain_cost.bin (docs/data-contract.md, section 1),
// so the engine does not apply it. Only the test fixture uses it, to build terrain_cost the same way the pipeline does.
export const CAUTION_SLOPE_PENALTY = 1.5;

// SOURCED: NASA EVA-EXP-0042 Rev B (2020), p. 29: EVAs of 4 to 8 hours (6 +/- 2). Adjustable.
export const EVA_DURATION_H = 6;

// SOURCED: Apollo PLSS design average, 1200 BTU/h (NTRS 19720019467).
export const AVG_METABOLIC_KJ_PER_H = 1266;

// SOURCED: Apollo geological station activity, 244 kcal/h = 284 W (Moore, NTRS 19910001262, p. 2).
export const STATION_WORK_W = 280;

// SOURCED: Apollo 12, second EVA: about twenty minutes at each of seven major stops (Apollo Lunar Surface Journal,
// docs/research.md, section 2.3). Time spent at each stop, at STATION_WORK_W. Adjustable.
export const STOP_DWELL_MIN = 20;

// ASSUMPTION: safety margin kept unused on return. Adjustable.
export const RESERVE_FRACTION = 0.2;

// ASSUMPTION: no Mars rule published. Adjustable. Used by Phase 4 buddy separation tracking.
export const BUDDY_MAX_SEPARATION_M = 100;

// SOURCED: NASA Lunar Rescue System webinar (NTRS 20250000528, 2025): one crewmember transports an incapacitated
// crewmember up to 2 km, slopes up to 20 deg. Limits the carry path of a rescue.
export const RESCUE_DISTANCE_M = 2000;

// ---- Body and load ----

// ASSUMPTION: typical body mass.
export const ASTRONAUT_MASS_KG = 80;

// ASSUMPTION: suit + life support + tools. No Mars suit exists yet. Adjustable.
export const SUIT_AND_GEAR_MASS_KG = 120;

// SOURCED: Norcross et al., NASA/TP-2010-216115, p. 56: site-to-site walking 1.1 to 1.4 m/s (lunar). Lower end.
export const WALK_SPEED_M_PER_S = 1.1;

// ASSUMPTION: slower pace while carrying a crewmember. Used by Phase 4 rescue mode.
export const RESCUE_SPEED_M_PER_S = 0.5;

// ---- Santee et al. (2001) load-carriage model, docs/assumptions.md "Metabolic model" ----
// Coefficients as written there:
//   W_level = (3.28 * M + 71.1) * (0.661 * v * cos(theta) + 0.115)
//   W_up    = 3.5 * M * g * v * sin(theta)
//   W_down  = 2.4 * M * g * v * sin(theta) * 0.3 ** (abs(theta_deg) / 7.65)
// Confirmed only through Johnson et al. 2010, Table 2 (docs/research.md, section 2.5). Fitting the model at Mars gravity is an ASSUMPTION.
export const SANTEE_LEVEL_MASS_COEF = 3.28;
export const SANTEE_LEVEL_OFFSET_W = 71.1;
export const SANTEE_LEVEL_SPEED_COEF = 0.661;
export const SANTEE_LEVEL_BASE = 0.115;
export const SANTEE_UPHILL_COEF = 3.5;
export const SANTEE_DOWNHILL_COEF = 2.4;
export const SANTEE_DOWNHILL_DECAY_BASE = 0.3;
export const SANTEE_DOWNHILL_DECAY_DEG = 7.65;

// ASSUMPTION: W_total = max(W_level + W_slope, W_level * 0.5). Stops steep downhill edges from giving near-zero cost.
export const SANTEE_MIN_LEVEL_FRACTION = 0.5;

// ---- Engine (Phase 2) ----

// ASSUMPTION (derived from two SOURCED values): walk-back energy budget = EVA_DURATION_H * AVG_METABOLIC_KJ_PER_H.
// Using the design-average rate as a whole-EVA energy budget is our choice. Adjustable with setParams.
export const EVA_ENERGY_BUDGET_J = EVA_DURATION_H * AVG_METABOLIC_KJ_PER_H * 1000;

// ASSUMPTION: a diagonal move needs both side neighbours passable, so a route cannot slip through an impassable band.
export const NO_CORNER_CUTTING = true;

// ASSUMPTION: only the habitat and the rover are full radiation shelters (docs/assumptions.md, FULL_SHELTERS).
export const FULL_SHELTERS = ["habitat", "rover"];

// ASSUMPTION: warn when the crew needs longer than this to reach a full shelter in a solar particle event.
// Lower end of the 30 to 60 min particle onset after the 2013-2014 flares (docs/research.md, section 2.6). Adjustable.
export const SEP_SHELTER_TARGET_MIN = 30;

// DEFINITION: unit conversions (docs/assumptions.md, "Units").
export const SECONDS_PER_HOUR = 3600;
export const SECONDS_PER_MINUTE = 60;
