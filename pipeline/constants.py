"""Constants used by the Phase 1 pipeline.

Every name and value here is listed in docs/assumptions.md with its status and reason.
Change a value there first, then here. export.py copies the docs/assumptions.md table into
meta.json, and tests/test_outputs.py checks that each value here matches its row there.
"""

# ---------------------------------------------------------------- SOURCED (docs/assumptions.md)

MAX_SLOPE_DEG = 20
CAUTION_SLOPE_DEG = 15
MAX_WALK_RADIUS_M = 2000

# ---------------------------------------------------------------- ASSUMPTION (docs/assumptions.md)

ROUTING_CELL_SIZE_M = 3.0
CAUTION_SLOPE_PENALTY = 1.5

# Terrain cost
ROUGHNESS_DETREND_SIGMA_M = 2.0
ROUGHNESS_COST_PER_M = 0.5
ROUGHNESS_MAX_FACTOR = 1.5
BOULDER_COST_FACTOR = 1.3

# Boulder shadows in the orthophoto
BOULDER_LOCAL_WINDOW_M = 25.0
BOULDER_SHADOW_DARKNESS = 0.6
BOULDER_MIN_SHADOW_AREA_M2 = 1.0
BOULDER_MAX_SHADOW_AREA_M2 = 25.0
BOULDER_MAX_ELONGATION = 2.5

# Terrain radiation shielding
SHIELD_AZIMUTHS = 16
SHIELD_SEARCH_RADIUS_M = 300.0

# DEM quality (low-confidence mask)
DEM_QUALITY_COLUMN_RUN_M = 151.0
DEM_QUALITY_WINDOW_M = 30.0
DEM_QUALITY_COHERENCE_MIN = 0.42
DEM_QUALITY_MIN_AREA_M2 = 1800.0

# Science value
SCIENCE_WEIGHT_SULFATE = 0.5
SCIENCE_WEIGHT_RIDGE = 0.5
RIDGE_RADIUS_M = 15.0
SCIENCE_NORMALIZE_LOW_PERCENTILE = 2
SCIENCE_NORMALIZE_HIGH_PERCENTILE = 99.5
SCIENCE_STOP_COUNT = 12
SCIENCE_STOP_MIN_SPACING_M = 150.0

# Habitat, rover and pickup zones
ROVER_PICKUP_MAX_SLOPE_DEG = 5
ROVER_PICKUP_MIN_AREA_M2 = 900.0
ROVER_PICKUP_MAX_COUNT = 6
ROVER_PICKUP_MIN_SPACING_M = 300.0
HABITAT_MIN_FLAT_AREA_M2 = 2500.0

# Walkability (same rule as the engine, so both agree on which points are reachable)
NO_CORNER_CUTTING = True


def all_constants():
    """All constants above as {name: value}. The status lives in docs/assumptions.md only."""
    return {name: value for name, value in globals().items() if name.isupper()}
