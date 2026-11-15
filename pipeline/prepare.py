"""Phase 1: turn the clipped raw data into the routing grid and app files.

Usage: python prepare.py --config ../sites/gale_boxwork.yaml

Inputs come from data/raw/ (made by fetch_data.py). Outputs go to
app/public/sites/<site>/ in the format of docs/data-contract.md.

This file builds the terrain grids (elevation, slope, roughness, DEM quality,
boulders, shielding) and picks the site points (habitat, rover, pickup zones,
science stops). layers.py adds CRISM, THEMIS and the science value.
export.py writes the files.
"""

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import rasterio
import yaml
from pyproj import CRS, Transformer
from rasterio.transform import Affine
from scipy import ndimage
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

import export
import layers
from constants import (
    BOULDER_COST_FACTOR, BOULDER_LOCAL_WINDOW_M, BOULDER_MAX_ELONGATION, BOULDER_MAX_SHADOW_AREA_M2,
    BOULDER_MIN_SHADOW_AREA_M2, BOULDER_SHADOW_DARKNESS, CAUTION_SLOPE_DEG, CAUTION_SLOPE_PENALTY,
    DEM_QUALITY_COHERENCE_MIN, DEM_QUALITY_COLUMN_RUN_M, DEM_QUALITY_MIN_AREA_M2, DEM_QUALITY_WINDOW_M,
    HABITAT_MIN_FLAT_AREA_M2, MAX_SLOPE_DEG, MAX_WALK_RADIUS_M, NO_CORNER_CUTTING, ROUGHNESS_COST_PER_M, ROUGHNESS_DETREND_SIGMA_M,
    ROUGHNESS_MAX_FACTOR, ROUTING_CELL_SIZE_M, ROVER_PICKUP_MAX_COUNT, ROVER_PICKUP_MAX_SLOPE_DEG,
    ROVER_PICKUP_MIN_AREA_M2, ROVER_PICKUP_MIN_SPACING_M, SCIENCE_STOP_COUNT, SCIENCE_STOP_MIN_SPACING_M,
    SHIELD_AZIMUTHS, SHIELD_SEARCH_RADIUS_M,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw"
MANIFEST_PATH = REPO_ROOT / "data" / "manifest.json"
LONLAT_PROJ = "+proj=longlat +R=3396190 +no_defs"  # same sphere as the USGS products

IMPASSABLE = 255
MAX_COST_BYTE = 254
COST_SCALE = 0.1  # docs/data-contract.md: multiplier = byte * 0.1


def log(message):
    print(message, flush=True)


# ---------------------------------------------------------------- grid helpers


def block_mean(values, factor):
    """Mean of each factor x factor block. A block with any NaN becomes NaN."""
    height, width = values.shape[0] // factor, values.shape[1] // factor
    blocks = values[:height * factor, :width * factor].reshape(height, factor, width, factor)
    return blocks.mean(axis=(1, 3))


def block_any(mask, factor):
    height, width = mask.shape[0] // factor, mask.shape[1] // factor
    blocks = mask[:height * factor, :width * factor].reshape(height, factor, width, factor)
    return blocks.any(axis=(1, 3))


def shifted(values, d_row, d_col, fill):
    """out[r, c] = values[r + d_row, c + d_col], and `fill` where that is outside the grid."""
    out = np.full_like(values, fill)
    height, width = values.shape
    if abs(d_row) >= height or abs(d_col) >= width:
        return out
    src_rows = slice(max(d_row, 0), height + min(d_row, 0))
    dst_rows = slice(max(-d_row, 0), height + min(-d_row, 0))
    src_cols = slice(max(d_col, 0), width + min(d_col, 0))
    dst_cols = slice(max(-d_col, 0), width + min(-d_col, 0))
    out[dst_rows, dst_cols] = values[src_rows, src_cols]
    return out


def remove_small_regions(mask, min_cells):
    labels, count = ndimage.label(mask, structure=np.ones((3, 3)))
    if count == 0:
        return mask
    sizes = np.bincount(labels.ravel())
    keep = sizes >= min_cells
    keep[0] = False
    return keep[labels]


# ---------------------------------------------------------------- terrain


def slope_degrees(elevation, cell_m):
    """Horn (1981) slope. Edge cells reuse their nearest neighbour. NaN spreads to the neighbours."""
    z = np.pad(elevation, 1, mode="edge")
    a, b, c = z[:-2, :-2], z[:-2, 1:-1], z[:-2, 2:]
    d, f = z[1:-1, :-2], z[1:-1, 2:]
    g, h, i = z[2:, :-2], z[2:, 1:-1], z[2:, 2:]
    dz_dx = ((c + 2 * f + i) - (a + 2 * d + g)) / (8 * cell_m)
    dz_dy = ((g + 2 * h + i) - (a + 2 * b + c)) / (8 * cell_m)
    return np.degrees(np.arctan(np.hypot(dz_dx, dz_dy)))


def roughness_rms(dem, factor, pixel_m):
    """RMS (m) of the fine DEM detail inside each routing cell.

    Detail = DEM minus a Gaussian-smoothed DEM, so the cell slope itself does not count as roughness.
    """
    filled = np.where(np.isnan(dem), np.nanmean(dem), dem)
    detail = filled - ndimage.gaussian_filter(filled, ROUGHNESS_DETREND_SIGMA_M / pixel_m, mode="nearest")
    return np.sqrt(block_mean(detail ** 2, factor))


def low_confidence_mask(dem, factor, pixel_m):
    """Measured DEM artifact test (decision of the project owner, 2026-11-14).

    The stripes in the east of the AOI follow the DEM pixel columns exactly. Real ridges and
    scarps drift off a pixel column within a few tens of meters. So the test asks: how much of
    the fine detail across columns (the second difference along x) keeps its sign straight down
    a column for DEM_QUALITY_COLUMN_RUN_M?

        coherence = |mean of signed d2x over the run| / mean of |d2x| over the run

    Random texture gives a low value (positive and negative cancel). A column-locked stripe
    gives a value near 1. The score is averaged over DEM_QUALITY_WINDOW_M and thresholded.
    Returns (mask, score) on the routing grid.
    """
    d2x = np.zeros_like(dem)
    d2x[:, 1:-1] = dem[:, 2:] - 2 * dem[:, 1:-1] + dem[:, :-2]
    d2x = np.nan_to_num(d2x, nan=0.0)

    run_px = int(round(DEM_QUALITY_COLUMN_RUN_M / pixel_m))
    signed = ndimage.uniform_filter1d(d2x, run_px, axis=0, mode="reflect")
    unsigned = ndimage.uniform_filter1d(np.abs(d2x), run_px, axis=0, mode="reflect")
    coherence = np.abs(signed) / (unsigned + 1e-6)  # 1e-6 m: avoids 0/0 on a perfectly flat run

    window_px = int(round(DEM_QUALITY_WINDOW_M / pixel_m))
    score = block_mean(ndimage.uniform_filter(coherence, window_px, mode="nearest"), factor)

    cell_area_m2 = (factor * pixel_m) ** 2
    mask = remove_small_regions(score > DEM_QUALITY_COHERENCE_MIN, math.ceil(DEM_QUALITY_MIN_AREA_M2 / cell_area_m2))
    no_data = block_any(np.isnan(dem), factor)
    return mask | no_data, score


def boulder_shadows(luminance, pixel_m):
    """Keep compact, roundish dark blobs (boulder shadows). Reject long thin ones (ridge shadows).

    A pixel is "shadow" when it is darker than BOULDER_SHADOW_DARKNESS x the local mean brightness.
    Each 8-connected shadow blob is kept when its area is in the boulder range and its
    elongation (ratio of the principal axes from the second moments) is small.
    Returns (kept-shadow mask, list of (row, col) blob centroids in image pixels).
    """
    window_px = int(round(BOULDER_LOCAL_WINDOW_M / pixel_m))
    local_mean = ndimage.uniform_filter(luminance, window_px, mode="nearest")
    dark = luminance < BOULDER_SHADOW_DARKNESS * local_mean

    labels, count = ndimage.label(dark, structure=np.ones((3, 3)))
    if count == 0:
        return np.zeros_like(dark), []
    # Moments from the dark pixels only: the full image has tens of millions of pixels.
    rows, cols = np.nonzero(labels)
    blob_of_pixel = labels[rows, cols]
    rows, cols = rows.astype(np.float64), cols.astype(np.float64)

    def per_blob(weights):
        return np.bincount(blob_of_pixel, weights=weights, minlength=count + 1)

    area = per_blob(None)
    area_safe = np.maximum(area, 1)
    mean_r, mean_c = per_blob(rows) / area_safe, per_blob(cols) / area_safe
    # 1/12 px^2 is the variance of one square pixel: a one-pixel-wide line still has a width.
    var_r = per_blob(rows ** 2) / area_safe - mean_r ** 2 + 1 / 12
    var_c = per_blob(cols ** 2) / area_safe - mean_c ** 2 + 1 / 12
    cov = per_blob(rows * cols) / area_safe - mean_r * mean_c
    half_trace = (var_r + var_c) / 2
    spread = np.sqrt(np.maximum(half_trace ** 2 - (var_r * var_c - cov ** 2), 0))
    major, minor = half_trace + spread, np.maximum(half_trace - spread, 1e-9)
    elongation = np.sqrt(major / minor)

    pixel_area = pixel_m ** 2
    is_boulder = (
        (area * pixel_area >= BOULDER_MIN_SHADOW_AREA_M2)
        & (area * pixel_area <= BOULDER_MAX_SHADOW_AREA_M2)
        & (elongation <= BOULDER_MAX_ELONGATION)
    )
    is_boulder[0] = False
    centroids = [(mean_r[k], mean_c[k]) for k in np.flatnonzero(is_boulder)]
    return is_boulder[labels], centroids


def detect_boulders(ortho_path, grid_shape):
    with rasterio.open(ortho_path) as src:
        rgb = src.read().astype(np.float32)
        pixel_m = src.res[0]
    # Mean of the bands. Part of the west edge is grayscale (3 equal bands), so this works for both.
    luminance = rgb.mean(axis=0)
    del rgb
    shadow_mask, centroids = boulder_shadows(luminance, pixel_m)

    cells = np.zeros(grid_shape, dtype=bool)
    pixels_per_cell = ROUTING_CELL_SIZE_M / pixel_m
    for row, col in centroids:
        cells[int(row // pixels_per_cell), int(col // pixels_per_cell)] = True
    return cells, shadow_mask, pixel_m, len(centroids)


def sky_view(elevation, cell_m):
    """Zenith-weighted open sky, 0..1 (TERRAIN_SHIELD_MODEL in docs/assumptions.md).

    For each azimuth, find the horizon angle h within SHIELD_SEARCH_RADIUS_M. The share of
    open sky in that direction is cos^2(h): this weights the sky near the zenith most, because
    particles from low angles cross more atmosphere. Terrain outside the grid counts as open sky.
    """
    filled = np.where(np.isnan(elevation), -np.inf, elevation)
    steps = int(SHIELD_SEARCH_RADIUS_M // cell_m)
    total = np.zeros_like(elevation)
    for k in range(SHIELD_AZIMUTHS):
        azimuth = 2 * math.pi * k / SHIELD_AZIMUTHS  # 0 = north, clockwise
        d_col, d_row = math.sin(azimuth), -math.cos(azimuth)  # row grows to the south
        max_tan = np.zeros_like(elevation)
        seen = set()
        for step in range(1, steps + 1):
            offset = (int(round(step * d_row)), int(round(step * d_col)))
            if offset in seen:
                continue
            seen.add(offset)
            distance_m = math.hypot(*offset) * cell_m
            rise = shifted(filled, offset[0], offset[1], -np.inf) - elevation
            np.maximum(max_tan, rise / distance_m, out=max_tan)
        total += 1 / (1 + max_tan ** 2)  # cos^2(atan(t)) = 1 / (1 + t^2)
    result = total / SHIELD_AZIMUTHS
    result[np.isnan(elevation)] = np.nan
    return result


def terrain_cost(slope, roughness, boulder_cells):
    """uint8 terrain multiplier (docs/data-contract.md, section 1)."""
    multiplier = np.ones_like(slope)
    caution = (slope > CAUTION_SLOPE_DEG) & (slope <= MAX_SLOPE_DEG)
    multiplier[caution] *= CAUTION_SLOPE_PENALTY
    multiplier *= np.minimum(1 + ROUGHNESS_COST_PER_M * roughness, ROUGHNESS_MAX_FACTOR)
    multiplier[boulder_cells] *= BOULDER_COST_FACTOR

    cost = np.clip(np.round(multiplier / COST_SCALE), 1, MAX_COST_BYTE).astype(np.uint8)
    impassable = (slope > MAX_SLOPE_DEG) | np.isnan(slope) | np.isnan(roughness)
    cost[impassable] = IMPASSABLE
    return cost


# ---------------------------------------------------------------- site points


def lonlat_to_cell(lon, lat, grid_transform, crs_wkt):
    to_grid = Transformer.from_crs(CRS.from_proj4(LONLAT_PROJ), CRS.from_wkt(crs_wkt), always_xy=True)
    x, y = to_grid.transform(lon, lat)
    col, row = ~grid_transform * (x, y)
    return int(math.floor(row)), int(math.floor(col))


def interior_cell(zone_mask, distance_to_edge):
    """The cell of a zone that is farthest from the zone edge. Ties: smallest row, then column."""
    inside = np.where(zone_mask, distance_to_edge, -1)
    row, col = np.unravel_index(int(np.argmax(inside)), inside.shape)
    return int(row), int(col)


def cell_distance_m(a, b, cell_m):
    return math.hypot(a[0] - b[0], a[1] - b[1]) * cell_m


def walkable_reachable(cost, elevation, start, cell_m):
    """Cells the crew can walk to from `start` under the engine's edge rules (edgeEnergyJ in engine/src/engine.ts).

    An edge between 8-neighbours is walkable when both cells are passable, the elevation step is not
    steeper than MAX_SLOPE_DEG, and (NO_CORNER_CUTTING) a diagonal has both side neighbours passable.
    A plain label of the passable cells is not enough: it lets a diagonal slip between two impassable
    cells and ignores a steep step between two passable cells, so the engine could not reach a point
    the pipeline published. Every rule is symmetric, so one undirected graph serves both directions.
    """
    height, width = cost.shape
    passable = cost != IMPASSABLE
    index = np.arange(height * width).reshape(height, width)
    # Same expression as the engine (maxSlopeDeg * (PI / 180)), so both agree on edges right at the limit.
    max_rise_per_m = math.tan(MAX_SLOPE_DEG * (math.pi / 180))

    edge_from, edge_to = [], []
    for d_row, d_col in ((0, 1), (1, 0), (1, 1), (1, -1)):  # E, S, SE, SW: each undirected edge once
        u_rows, v_rows = slice(0, height - d_row), slice(d_row, height)
        u_cols, v_cols = slice(max(0, -d_col), width - max(0, d_col)), slice(max(0, d_col), width + min(0, d_col))
        is_diagonal = d_row != 0 and d_col != 0

        walkable = passable[u_rows, u_cols] & passable[v_rows, v_cols]
        if is_diagonal and NO_CORNER_CUTTING:
            walkable &= passable[u_rows, v_cols] & passable[v_rows, u_cols]
        run_m = cell_m * math.sqrt(2) if is_diagonal else cell_m
        rise_m = elevation[v_rows, v_cols] - elevation[u_rows, u_cols]
        walkable &= np.abs(rise_m) <= run_m * max_rise_per_m

        edge_from.append(index[u_rows, u_cols][walkable])
        edge_to.append(index[v_rows, v_cols][walkable])

    edge_from, edge_to = np.concatenate(edge_from), np.concatenate(edge_to)
    graph = coo_matrix((np.ones(edge_from.size, dtype=np.int8), (edge_from, edge_to)), shape=(height * width,) * 2)
    _, labels = connected_components(graph, directed=False)
    labels = labels.reshape(height, width)
    return labels == labels[start]


def flat_zones(cost, slope, cell_m):
    flat = (slope < ROVER_PICKUP_MAX_SLOPE_DEG) & (cost != IMPASSABLE)
    labels, count = ndimage.label(flat, structure=np.ones((3, 3)))
    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    distance = ndimage.distance_transform_edt(flat)
    zones = []
    for label in range(1, count + 1):
        area_m2 = sizes[label] * cell_m ** 2
        if area_m2 < ROVER_PICKUP_MIN_AREA_M2:
            continue
        zones.append({"label": label, "areaM2": float(area_m2), "cell": interior_cell(labels == label, distance)})
    return labels, zones


def curiosity_stops(config, grid_transform):
    """Curiosity end-of-drive positions in the campaign sol range, as grid cells.

    data/raw/msl_waypoints.json gives easting/northing in the same projection as the DEM
    (docs/datasets.md, AOI section). Checked: they match the converted lat/lon within 3 mm.
    """
    features = json.loads((RAW_DIR / "msl_waypoints.json").read_text(encoding="utf-8"))["features"]
    points = []
    for feature in features:
        p = feature["properties"]
        if not config["aoi_sol_min"] <= p["sol"] <= config["aoi_sol_max"]:
            continue
        col, row = ~grid_transform * (p["easting"], p["northing"])
        points.append({"cell": (int(math.floor(row)), int(math.floor(col))),
                       "sol": int(p["sol"]), "roverSite": int(p["site"]), "roverDrive": int(p["drive"])})
    return points


def choose_sites(config, cost, slope, elevation, science, quality, grid_transform, crs_wkt, curiosity_points):
    """Habitat, reachable area, rover pickup zones, science stops and rover parking.

    Every rule here uses constants from docs/assumptions.md. The YAML can override the
    habitat and the rover position with habitat_lat/lon and rover_lat/lon.
    """
    cell_m = ROUTING_CELL_SIZE_M
    height, width = cost.shape
    center = (height / 2, width / 2)
    labels, zones = flat_zones(cost, slope, cell_m)

    if config.get("habitat_lat") is not None:
        habitat = lonlat_to_cell(config["habitat_lon"], config["habitat_lat"], grid_transform, crs_wkt)
        habitat_source = "site YAML (habitat_lat, habitat_lon)"
    else:
        big = [z for z in zones if z["areaM2"] >= HABITAT_MIN_FLAT_AREA_M2]
        if not big:
            raise RuntimeError("no flat zone is large enough for the habitat; set habitat_lat/lon in the YAML")
        nearest = min(big, key=lambda z: (cell_distance_m(z["cell"], center, cell_m), z["cell"]))
        habitat = nearest["cell"]
        habitat_source = ("pipeline rule (ASSUMPTION): most interior cell of the flat zone "
                          f"(slope < {ROVER_PICKUP_MAX_SLOPE_DEG} deg, area >= {HABITAT_MIN_FLAT_AREA_M2:.0f} m2) nearest the AOI center")
    if cost[habitat] == IMPASSABLE:
        raise RuntimeError(f"habitat cell {habitat} is impassable")

    reachable = walkable_reachable(cost, elevation, habitat, cell_m)

    pickups = []
    for zone in sorted(zones, key=lambda z: (-z["areaM2"], z["cell"])):
        if len(pickups) >= ROVER_PICKUP_MAX_COUNT:
            break
        if not reachable[zone["cell"]]:
            continue
        others = [habitat] + [p["cell"] for p in pickups]
        if min(cell_distance_m(zone["cell"], o, cell_m) for o in others) < ROVER_PICKUP_MIN_SPACING_M:
            continue
        pickups.append({"id": f"rp{len(pickups) + 1}", "cell": zone["cell"], "areaM2": zone["areaM2"]})

    # Science stops are real Curiosity stops (decision of the project owner, 2026-11-14), so the
    # rover's own images can show each stop. A stop on an impassable, unreachable or low-confidence
    # cell is skipped, not moved: Curiosity can drive slopes a suited human cannot walk.
    usable = []
    for point in curiosity_points:
        cell = point["cell"]
        inside = 0 <= cell[0] < height and 0 <= cell[1] < width
        if not inside or not reachable[cell] or quality[cell] != 0:
            continue
        if cell_distance_m(cell, habitat, cell_m) > MAX_WALK_RADIUS_M:
            continue
        usable.append({**point, "scienceValue": int(science[cell])})
    stops = []
    for point in sorted(usable, key=lambda p: (-p["scienceValue"], p["sol"], p["roverDrive"])):
        if len(stops) >= SCIENCE_STOP_COUNT:
            break
        others = [habitat] + [s["cell"] for s in stops]
        if min(cell_distance_m(point["cell"], o, cell_m) for o in others) < SCIENCE_STOP_MIN_SPACING_M:
            continue
        stops.append({**point, "id": f"s{len(stops) + 1}"})

    if config.get("rover_lat") is not None:
        rover = lonlat_to_cell(config["rover_lon"], config["rover_lat"], grid_transform, crs_wkt)
        rover_source = "site YAML (rover_lat, rover_lon)"
    elif pickups and stops:
        mid = (np.mean([s["cell"][0] for s in stops]), np.mean([s["cell"][1] for s in stops]))
        rover = min(pickups, key=lambda p: (cell_distance_m(p["cell"], mid, cell_m), p["id"]))["cell"]
        rover_source = "pipeline rule (ASSUMPTION): rover parked at the pickup zone nearest the middle of the science stops"
    else:
        rover = habitat
        rover_source = "pipeline rule (ASSUMPTION): no pickup zone found, rover parked at the habitat"

    return {
        "habitat": habitat, "habitatSource": habitat_source,
        "rover": rover, "roverSource": rover_source,
        "pickups": pickups, "stops": stops,
        "reachableShare": float(reachable.mean()),
        "curiosityUsable": len(usable),
    }


# ---------------------------------------------------------------- main


def load_manifest():
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = yaml.safe_load(Path(args.config).read_text(encoding="utf-8"))
    site_dir = REPO_ROOT / "app" / "public" / "sites" / config["site"]
    started = time.time()

    if float(config["routing_cell_size_m"]) != ROUTING_CELL_SIZE_M:
        raise SystemExit("routing_cell_size_m in the YAML differs from ROUTING_CELL_SIZE_M in docs/assumptions.md")

    dem_path = RAW_DIR / "dem_aoi.tif"
    with rasterio.open(dem_path) as src:
        dem = src.read(1).astype(np.float64)
        if src.nodata is not None:
            dem[dem == src.nodata] = np.nan
        dem_transform, crs_wkt, pixel_m = src.transform, src.crs.to_wkt(), src.res[0]
    factor = int(round(ROUTING_CELL_SIZE_M / pixel_m))
    if abs(factor * pixel_m - ROUTING_CELL_SIZE_M) > 1e-6 or dem.shape[0] % factor or dem.shape[1] % factor:
        raise SystemExit(f"the DEM ({dem.shape}, {pixel_m} m) does not divide into {ROUTING_CELL_SIZE_M} m cells")
    grid_transform = dem_transform * Affine.scale(factor)
    log(f"DEM {dem.shape[1]} x {dem.shape[0]} px at {pixel_m} m -> grid {dem.shape[1] // factor} x {dem.shape[0] // factor} at {ROUTING_CELL_SIZE_M} m")

    # Round to float32 first: elevation.bin is float32, and the slope limits must agree with what the engine reads.
    elevation = block_mean(dem, factor).astype(np.float32).astype(np.float64)
    slope = slope_degrees(elevation, ROUTING_CELL_SIZE_M)
    roughness = roughness_rms(dem, factor, pixel_m)
    quality, quality_score = low_confidence_mask(dem, factor, pixel_m)
    del dem
    log(f"slope: {np.mean(slope > MAX_SLOPE_DEG):.1%} of cells above {MAX_SLOPE_DEG} deg, "
        f"{np.mean((slope > CAUTION_SLOPE_DEG) & (slope <= MAX_SLOPE_DEG)):.1%} in the caution band")
    log(f"DEM quality: {quality.mean():.2%} of cells low confidence")

    boulder_cells, boulder_mask, ortho_pixel_m, boulder_count = detect_boulders(RAW_DIR / "ortho_aoi.tif", elevation.shape)
    log(f"boulders: {boulder_count} compact shadows kept, in {boulder_cells.sum()} cells")

    shield = sky_view(elevation, ROUTING_CELL_SIZE_M)
    log(f"shield: open sky share {np.nanmin(shield):.3f} to {np.nanmax(shield):.3f}")

    sulfate, crism_info = layers.crism_sulfate(RAW_DIR / "crism", grid_transform, elevation.shape, crs_wkt)
    thermal = layers.themis_brightness(RAW_DIR / "themis_day_aoi.tif", grid_transform, elevation.shape, crs_wkt)
    ridge = layers.ridge_score(elevation, ROUTING_CELL_SIZE_M)
    science = layers.science_value(sulfate, ridge)
    log(f"CRISM {crism_info['band']} (band {crism_info['bandNumber']}): {np.mean(~np.isnan(sulfate)):.1%} of cells valid")

    cost = terrain_cost(slope, roughness, boulder_cells)
    curiosity_points = curiosity_stops(config, grid_transform)
    sites = choose_sites(config, cost, slope, elevation, science, quality, grid_transform, crs_wkt, curiosity_points)
    log(f"habitat at cell {sites['habitat']}; {sites['reachableShare']:.1%} of cells reachable on foot; "
        f"{len(sites['pickups'])} pickup zones; {len(sites['stops'])} science stops from {sites['curiosityUsable']} usable of {len(curiosity_points)} Curiosity stops")

    grids = {
        "elevation": elevation, "slope": slope, "cost": cost, "shield": shield, "science": science,
        "quality": quality, "qualityScore": quality_score, "sulfate": sulfate, "ridge": ridge, "thermal": thermal,
        "boulderMask": boulder_mask, "boulderPixelM": ortho_pixel_m, "boulderCount": boulder_count,
    }
    export.write_site(site_dir, config, grids, sites, grid_transform, crs_wkt, crism_info, load_manifest())
    log(f"done in {time.time() - started:.0f} s -> {site_dir.relative_to(REPO_ROOT).as_posix()}")


if __name__ == "__main__":
    main()
