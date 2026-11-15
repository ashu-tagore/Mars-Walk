"""Unit tests of the terrain functions on small synthetic test grids.

These grids are test fixtures only. They are never written to the app.
"""

import math

import numpy as np

from constants import CAUTION_SLOPE_PENALTY, MAX_SLOPE_DEG
from prepare import (
    IMPASSABLE, boulder_shadows, low_confidence_mask, sky_view, slope_degrees, terrain_cost, walkable_reachable,
)


def plane(height, width, slope_deg, cell_m):
    rise_per_col = math.tan(math.radians(slope_deg)) * cell_m
    return np.tile(np.arange(width) * rise_per_col, (height, 1)).astype(np.float64)


def test_slope_of_a_plane():
    slope = slope_degrees(plane(20, 20, 10.0, 3.0), 3.0)
    assert np.allclose(slope[1:-1, 1:-1], 10.0, atol=1e-6)


def test_terrain_cost_bands():
    slope = np.array([[0.0, 17.0, MAX_SLOPE_DEG + 0.1, np.nan]])
    roughness = np.zeros_like(slope)
    cost = terrain_cost(slope, roughness, np.zeros(slope.shape, dtype=bool))
    assert cost[0, 0] == 10  # multiplier 1.0
    assert cost[0, 1] == round(CAUTION_SLOPE_PENALTY * 10)
    assert cost[0, 2] == IMPASSABLE
    assert cost[0, 3] == IMPASSABLE


def test_boulder_filter_keeps_round_and_rejects_long_thin():
    image = np.full((200, 200), 100.0)
    image[50:56, 50:56] = 20.0  # compact 3 m x 3 m shadow at 0.5 m pixels
    image[120:122, 20:180] = 20.0  # long thin shadow, like a ridge
    mask, centroids = boulder_shadows(image, 0.5)
    assert mask[52, 52]
    assert not mask[121, 100]
    assert len(centroids) == 1


def test_low_confidence_flags_column_stripes_only():
    rng = np.random.default_rng(0)
    noise = rng.normal(0.0, 0.1, (300, 300))
    striped = noise.copy()
    striped[:, 150:] += np.tile(np.where(np.arange(150) % 4 < 2, 0.3, -0.3), (300, 1))
    clean_mask, _ = low_confidence_mask(noise, 3, 1.0)
    striped_mask, _ = low_confidence_mask(striped, 3, 1.0)
    assert not clean_mask.any()
    assert striped_mask[:, 60:].mean() > 0.9
    assert not striped_mask[:, :40].any()


def test_sky_view_open_on_flat_and_reduced_in_a_pit():
    flat = np.zeros((60, 60))
    assert np.allclose(sky_view(flat, 3.0), 1.0)
    pit = flat.copy()
    pit[25:35, 25:35] = -20.0
    view = sky_view(pit, 3.0)
    assert view[30, 30] < 0.9
    assert view[30, 30] > 0.0  # terrain gives partial shielding, never full


def test_reachability_uses_the_engine_edge_rules():
    """The engine blocks diagonal corner cutting and edges steeper than MAX_SLOPE_DEG (edgeEnergyJ)."""
    cell_m = 3.0
    flat = np.zeros((2, 2))
    # Only a diagonal between two impassable cells links (0, 0) to (1, 1).
    corner = np.array([[10, IMPASSABLE], [IMPASSABLE, 10]], dtype=np.uint8)
    assert not walkable_reachable(corner, flat, (0, 0), cell_m)[1, 1]

    # Two passable cells, but the step between them is steeper than MAX_SLOPE_DEG.
    passable = np.full((1, 2), 10, dtype=np.uint8)
    steep_rise = cell_m * math.tan(math.radians(MAX_SLOPE_DEG + 1))
    gentle_rise = cell_m * math.tan(math.radians(MAX_SLOPE_DEG - 1))
    assert not walkable_reachable(passable, np.array([[0.0, steep_rise]]), (0, 0), cell_m)[0, 1]
    assert walkable_reachable(passable, np.array([[0.0, gentle_rise]]), (0, 0), cell_m)[0, 1]
