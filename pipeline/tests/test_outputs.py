"""Checks the files prepare.py wrote against docs/data-contract.md (version 9).

Run prepare.py first. The tests skip when the site has not been built.
"""

import json
import math
import re
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from constants import CAUTION_SLOPE_DEG, CAUTION_SLOPE_PENALTY, MAX_SLOPE_DEG, MAX_WALK_RADIUS_M, all_constants
from prepare import IMPASSABLE, slope_degrees

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SITE_DIR = REPO_ROOT / "app" / "public" / "sites" / "gale_boxwork"
META_PATH = SITE_DIR / "meta.json"
DTYPES = {"float32": np.dtype("<f4"), "uint8": np.dtype(np.uint8)}

pytestmark = pytest.mark.skipif(not META_PATH.exists(), reason="run prepare.py first")


@pytest.fixture(scope="module")
def meta():
    return json.loads(META_PATH.read_text(encoding="utf-8"))


def load_layer(meta, name):
    layer = meta["layers"][name]
    values = np.fromfile(SITE_DIR / layer["file"], dtype=DTYPES[layer["type"]])
    return values.reshape(meta["height"], meta["width"])


def test_meta_has_contract_keys(meta):
    required = ["version", "site", "width", "height", "cellSizeMeters", "crs", "transform", "bounds", "byteOrder",
                "rowOrder", "noData", "layers", "tiles", "overlays", "habitat", "shelters", "roverPickupZones",
                "waypoints", "sources", "notes", "constants"]
    assert [key for key in required if key not in meta] == []
    assert meta["version"] == 9
    assert meta["byteOrder"] == "little" and meta["rowOrder"] == "north_to_south"
    assert set(meta["layers"]) == {"elevation", "terrainCost", "shield", "scienceValue", "demQuality"}


def test_each_bin_has_width_times_height_elements(meta):
    for name, layer in meta["layers"].items():
        size = (SITE_DIR / layer["file"]).stat().st_size
        assert size == meta["width"] * meta["height"] * DTYPES[layer["type"]].itemsize, name


def test_transform_and_bounds_agree(meta):
    pixel_width, _, west, _, pixel_height, north = meta["transform"]
    assert pixel_width == meta["cellSizeMeters"] and pixel_height == -meta["cellSizeMeters"]
    bounds = meta["bounds"]
    assert bounds["west"] == west and bounds["north"] == north
    assert math.isclose(bounds["east"], west + pixel_width * meta["width"])
    assert math.isclose(bounds["south"], north + pixel_height * meta["height"])


def test_layer_values_are_in_range(meta):
    elevation = load_layer(meta, "elevation")
    valid = elevation[elevation != meta["noData"]]
    assert np.isfinite(elevation).all()
    assert valid.min() > -9000 and valid.max() < 30000
    assert set(np.unique(load_layer(meta, "demQuality"))) <= {0, 1}


def test_steep_cells_are_impassable_and_caution_cells_cost_more(meta):
    elevation = load_layer(meta, "elevation").astype(np.float64)
    elevation[elevation == meta["noData"]] = np.nan
    slope = slope_degrees(elevation, meta["cellSizeMeters"])
    cost = load_layer(meta, "terrainCost")
    assert (cost[slope > MAX_SLOPE_DEG] == IMPASSABLE).all()
    caution = (slope > CAUTION_SLOPE_DEG) & (slope <= MAX_SLOPE_DEG)
    assert (cost[caution] >= round(CAUTION_SLOPE_PENALTY * 10)).all()
    assert (cost[cost != IMPASSABLE] >= 10).all()  # no cell is cheaper than plain ground


def test_site_points_are_on_passable_cells_inside_the_grid(meta):
    cost = load_layer(meta, "terrainCost")
    points = [meta["habitat"]] + meta["shelters"] + meta["roverPickupZones"] + meta["waypoints"]
    for p in points:
        assert 0 <= p["col"] < meta["width"] and 0 <= p["row"] < meta["height"], p
        assert cost[p["row"], p["col"]] != IMPASSABLE, p
    assert {s["id"] for s in meta["shelters"]} == {"habitat", "rover"}
    assert all(s["kind"] == "full" for s in meta["shelters"])


def test_science_stops_are_within_walk_radius(meta):
    habitat = meta["habitat"]
    for stop in meta["waypoints"]:
        distance_m = math.hypot(stop["col"] - habitat["col"], stop["row"] - habitat["row"]) * meta["cellSizeMeters"]
        assert distance_m <= MAX_WALK_RADIUS_M, stop


def test_overlays_cover_the_grid_extent(meta):
    for overlay in meta["overlays"]:
        with Image.open(SITE_DIR / overlay["file"]) as image:
            assert image.mode == "RGBA", overlay["id"]
            assert image.width * meta["height"] == image.height * meta["width"], overlay["id"]
        assert overlay["source"] and isinstance(overlay["assumption"], bool)


def test_tile_pyramid_is_complete(meta):
    tiles = meta["tiles"]
    for zoom in range(tiles["minZoom"], tiles["maxZoom"] + 1):
        scale = 2.0 ** (zoom - tiles["maxZoom"])
        columns = math.ceil(round(tiles["widthPx"] * scale) / tiles["tileSize"])
        rows = math.ceil(round(tiles["heightPx"] * scale) / tiles["tileSize"])
        for x in range(columns):
            for y in range(rows):
                assert (SITE_DIR / tiles["path"].format(z=zoom, x=x, y=y)).exists(), (zoom, x, y)
    meters = tiles["widthPx"] * tiles["metersPerPixelAtMaxZoom"]
    assert math.isclose(meters, meta["width"] * meta["cellSizeMeters"])


def value_in_text(value, text):
    """True when the docs/assumptions.md Value text holds this code value (a number token, or true/false)."""
    if isinstance(value, bool):
        return str(value).lower() in text.lower()
    numbers = [float(token) for token in re.findall(r"-?\d+(?:\.\d+)?(?:e[+-]?\d+)?", text.replace(",", ""), re.I)]
    return any(math.isclose(number, value) for number in numbers)


def test_every_constant_is_documented_with_its_value(meta):
    """CLAUDE.md: never invent a constant. Each pipeline constant has a docs/assumptions.md row with the same value.

    meta.json constants is that table (docs/data-contract.md, section 2), so it also holds the engine rows.
    """
    table = meta["constants"]
    for name, value in all_constants().items():
        assert name in table, f"{name} is missing from docs/assumptions.md"
        assert value_in_text(value, table[name]["value"]), f"{name} = {value} differs from docs/assumptions.md ({table[name]['value']})"
    assert all(entry["status"] in ("SOURCED", "ASSUMPTION", "DEFINITION") and entry["source"] for entry in table.values())
    # Engine and model rows are there too, so the app can tag them.
    for name in ("RESERVE_FRACTION", "RESCUE_SPEED_M_PER_S", "SANTEE_MIN_LEVEL_FRACTION", "METABOLIC_MODEL_AT_MARS_GRAVITY"):
        assert table[name]["status"] == "ASSUMPTION", name
    assert table["EVA_ENERGY_BUDGET_J"]["status"] == "ASSUMPTION"  # derived from two SOURCED values, still our choice


def test_sources_and_notes_for_the_about_panel(meta):
    assert {s["id"] for s in meta["sources"]} == {"dem", "ortho", "crism", "themis", "waypoints", "rad"}
    assert next(s for s in meta["sources"] if s["id"] == "rad")["credit"] == "NASA/JPL-Caltech/SwRI"  # CLAUDE.md credits
    assert all(s["credit"] and s["url"].startswith("https://") for s in meta["sources"])
    assert any(n["id"] == "dem_east_strip" for n in meta["notes"])


def test_science_stops_are_real_curiosity_stops(meta):
    """Decision of the project owner (2026-11-14): stops are Curiosity end-of-drive positions."""
    features = json.loads((REPO_ROOT / "data" / "raw" / "msl_waypoints.json").read_text(encoding="utf-8"))["features"]
    by_key = {(f["properties"]["sol"], f["properties"]["site"], f["properties"]["drive"]): f["properties"] for f in features}
    _, _, west, _, _, north = meta["transform"]
    cell = meta["cellSizeMeters"]
    assert meta["waypoints"], "no science stops"
    for stop in meta["waypoints"]:
        real = by_key[(stop["sol"], stop["roverSite"], stop["roverDrive"])]
        assert stop["col"] == math.floor((real["easting"] - west) / cell), stop
        assert stop["row"] == math.floor((north - real["northing"]) / cell), stop


def test_each_stop_photo_is_from_that_stop(meta):
    """A stop photo must exist, carry a credit, and be from the stop's own sol."""
    manifest = json.loads((REPO_ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))["files"]
    for stop in meta["waypoints"]:
        if stop["pov"] is None:
            continue
        entry = manifest[f"data/raw/{stop['pov']}"]  # the original; the web copy has the same file name
        assert (SITE_DIR / stop["pov"]).exists(), stop["id"]
        assert stop["povCredit"] == entry["credit"], stop["id"]
        assert entry["sol"] == stop["sol"], stop["id"]


def test_manifest_lists_only_existing_downloads():
    """REVIEW.md F-11: the manifest tracks downloads in data/raw/ only, and each one is on disk."""
    manifest = json.loads((REPO_ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))["files"]
    outside_raw = [key for key in manifest if not key.startswith("data/raw/")]
    missing = [key for key in manifest if not (REPO_ROOT / key).exists()]
    assert outside_raw == []
    assert missing == []


def test_only_assigned_photos_are_deployed(meta):
    """REVIEW.md F-10: the web folder holds exactly the stop photos (originals stay in data/raw/pov/)."""
    deployed = {path.name for path in (SITE_DIR / "pov").glob("*.jpg")}
    assigned = {Path(stop["pov"]).name for stop in meta["waypoints"] if stop["pov"]}
    assert deployed == assigned
