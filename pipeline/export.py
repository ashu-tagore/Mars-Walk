"""Write the pipeline output in the format of docs/data-contract.md (version 8).

.bin layers, meta.json, orthophoto tile pyramid and display overlays.
"""

import json
import math
import re
import shutil
from pathlib import Path

import numpy as np
import rasterio
from PIL import Image

from constants import CAUTION_SLOPE_DEG, MAX_SLOPE_DEG, ROUTING_CELL_SIZE_M

CONTRACT_VERSION = 8
NO_DATA_FLOAT = -9999.0
TILE_SIZE = 256
TILE_JPEG_QUALITY = 85
DEM_EAST_STRIP_M = 100  # the strip the Phase 0 check found (docs/datasets.md, section 1); used only to report the test result
ASSUMPTIONS_PATH = Path(__file__).resolve().parent.parent / "docs" / "assumptions.md"
# A named table row: | NAME | value | status | source or reason |
ASSUMPTION_ROW = re.compile(r"^\| ([A-Z][A-Z0-9_]+) \| (.+?) \| (.+?) \| (.+) \|$", re.M)
ROW_STATUSES = ("ASSUMPTION", "SOURCED", "DEFINITION")
# Curiosity RAD values (docs/assumptions.md, radiation section) have no data file, so no manifest entry.
# Credit from CLAUDE.md. URL: the NASA release on the May 2024 event (docs/research.md, section 2.6).
RAD_SOURCE = {"id": "rad", "label": "Curiosity RAD radiation values", "credit": "NASA/JPL-Caltech/SwRI",
              "url": "https://www.nasa.gov/solar-system/planets/mars/nasa-watches-mars-light-up-during-epic-solar-storm/"}

# Display colors (RGBA). Not data: they only style the overlays.
COLOR_CAUTION = (255, 176, 0, 150)
COLOR_IMPASSABLE = (215, 35, 35, 170)
COLOR_BOULDER = (255, 70, 70, 255)
COLOR_LOW_CONFIDENCE = (0, 220, 255, 110)
RAMP_THERMAL = [(0.0, (25, 10, 70)), (0.5, (205, 65, 40)), (1.0, (255, 235, 130))]
RAMP_SULFATE = [(0.0, (60, 0, 80)), (1.0, (255, 60, 255))]
RAMP_SCIENCE = [(0.0, (0, 60, 30)), (1.0, (80, 255, 120))]
RAMP_SHIELD = [(0.0, (20, 40, 140)), (1.0, (120, 180, 255))]


# ---------------------------------------------------------------- binaries


def write_bin(path, values, dtype):
    np.ascontiguousarray(values, dtype=dtype).tofile(path)


def write_layers(site_dir, grids):
    elevation = np.where(np.isnan(grids["elevation"]), NO_DATA_FLOAT, grids["elevation"])
    shield = np.round(np.nan_to_num(grids["shield"], nan=0.0) * 255)
    write_bin(site_dir / "elevation.bin", elevation, "<f4")
    write_bin(site_dir / "terrain_cost.bin", grids["cost"], np.uint8)
    write_bin(site_dir / "shield.bin", shield, np.uint8)
    write_bin(site_dir / "science_val.bin", grids["science"], np.uint8)
    write_bin(site_dir / "dem_quality.bin", grids["quality"], np.uint8)


# ---------------------------------------------------------------- tiles


def write_tiles(ortho_path, tiles_dir):
    """XYZ pyramid, 256 px JPEG tiles, tile (0, 0) at the north-west corner (docs/data-contract.md, 1.1)."""
    if tiles_dir.exists():
        shutil.rmtree(tiles_dir)
    with rasterio.open(ortho_path) as src:
        image = Image.fromarray(np.moveaxis(src.read(), 0, -1), "RGB")
        pixel_m = src.res[0]
    width, height = image.size
    max_zoom = max(0, math.ceil(math.log2(max(width, height) / TILE_SIZE)))
    count = 0
    for zoom in range(max_zoom, -1, -1):
        scale = 2.0 ** (zoom - max_zoom)
        level = image if zoom == max_zoom else image.resize(
            (max(1, round(width * scale)), max(1, round(height * scale))), Image.LANCZOS, reducing_gap=2.0)
        columns, rows = math.ceil(level.width / TILE_SIZE), math.ceil(level.height / TILE_SIZE)
        for x in range(columns):
            folder = tiles_dir / str(zoom) / str(x)
            folder.mkdir(parents=True, exist_ok=True)
            for y in range(rows):
                tile = Image.new("RGB", (TILE_SIZE, TILE_SIZE))  # black outside the image
                tile.paste(level.crop((x * TILE_SIZE, y * TILE_SIZE,
                                       min((x + 1) * TILE_SIZE, level.width), min((y + 1) * TILE_SIZE, level.height))))
                tile.save(folder / f"{y}.jpg", quality=TILE_JPEG_QUALITY)
                count += 1
    return {
        "path": "tiles/{z}/{x}/{y}.jpg", "tileSize": TILE_SIZE, "minZoom": 0, "maxZoom": max_zoom,
        "metersPerPixelAtMaxZoom": pixel_m, "widthPx": width, "heightPx": height,
    }, count


# ---------------------------------------------------------------- overlays


def ramp(values01, stops, alpha):
    """RGBA image from 0..1 values by linear color stops. NaN = transparent."""
    positions = [p for p, _ in stops]
    rgba = np.zeros(values01.shape + (4,), dtype=np.uint8)
    clean = np.nan_to_num(values01, nan=0.0)
    for channel in range(3):
        rgba[..., channel] = np.interp(clean, positions, [color[channel] for _, color in stops])
    rgba[..., 3] = np.where(np.isnan(values01), 0, alpha)
    return rgba


def paint(mask, color):
    rgba = np.zeros(mask.shape + (4,), dtype=np.uint8)
    rgba[mask] = color
    return rgba


def min_max(values):
    low, high = np.nanmin(values), np.nanmax(values)
    return (values - low) / (high - low) if high > low else np.zeros_like(values)


def save_png(rgba, path):
    Image.fromarray(rgba, "RGBA").save(path, optimize=True)


def write_overlays(site_dir, grids, crism_info, credits):
    overlay_dir = site_dir / "overlays"
    if overlay_dir.exists():
        shutil.rmtree(overlay_dir)
    overlay_dir.mkdir(parents=True)
    slope = grids["slope"]

    slope_rgba = paint((slope > CAUTION_SLOPE_DEG) & (slope <= MAX_SLOPE_DEG), COLOR_CAUTION)
    slope_rgba[(slope > MAX_SLOPE_DEG) | np.isnan(slope)] = COLOR_IMPASSABLE
    save_png(slope_rgba, overlay_dir / "slope.png")

    # Boulder shadows at 1 m: a 0.5 m shadow pixel would vanish when the map is zoomed out.
    reduce = max(1, int(round(1.0 / grids["boulderPixelM"])))
    mask = grids["boulderMask"]
    h, w = mask.shape[0] // reduce, mask.shape[1] // reduce
    boulders_1m = mask[:h * reduce, :w * reduce].reshape(h, reduce, w, reduce).any(axis=(1, 3))
    save_png(paint(boulders_1m, COLOR_BOULDER), overlay_dir / "boulders.png")

    save_png(ramp(min_max(grids["thermal"]), RAMP_THERMAL, 190), overlay_dir / "thermal.png")
    save_png(ramp(min_max(grids["sulfate"]), RAMP_SULFATE, 170), overlay_dir / "crism_sulfate.png")
    save_png(paint(grids["quality"].astype(bool), COLOR_LOW_CONFIDENCE), overlay_dir / "dem_quality.png")

    science = grids["science"] / 255.0
    science_rgba = ramp(science, RAMP_SCIENCE, 0)
    science_rgba[..., 3] = np.round(science * 200).astype(np.uint8)
    save_png(science_rgba, overlay_dir / "science.png")

    # Only show where terrain blocks part of the sky; open ground stays clear.
    blocked = 1 - np.nan_to_num(grids["shield"], nan=1.0)
    shield_rgba = ramp(1 - min_max(blocked), RAMP_SHIELD, 0)
    shield_rgba[..., 3] = np.round(np.clip(blocked / max(blocked.max(), 1e-9), 0, 1) * 200).astype(np.uint8)
    save_png(shield_rgba, overlay_dir / "shield.png")

    return [
        {"id": "slope", "file": "overlays/slope.png", "label": "Slope limits",
         "description": f"Amber: {CAUTION_SLOPE_DEG} to {MAX_SLOPE_DEG} deg (caution penalty). Red: above {MAX_SLOPE_DEG} deg (impassable). "
                        f"Slope of {ROUTING_CELL_SIZE_M:g} m cells from the 1 m DEM.",
         "source": credits["dem"], "assumption": False},
        {"id": "boulders", "file": "overlays/boulders.png", "label": "Boulder shadows",
         "description": "Compact dark blobs in the orthophoto, kept as boulder shadows. Long thin shadows (ridges) are rejected. "
                        "Detection floor about 1.5 m. Thresholds are assumptions.",
         "source": credits["ortho"], "assumption": True},
        {"id": "thermal", "file": "overlays/thermal.png", "label": "THEMIS day IR",
         "description": "Daytime infrared brightness (about 163 m pixels). Image brightness, not calibrated temperature. Display only.",
         "source": credits["themis"], "assumption": False},
        {"id": "crism_sulfate", "file": "overlays/crism_sulfate.png", "label": f"CRISM {crism_info['band']} (sulfate)",
         "description": f"Sulfate index from {crism_info['file']} (about {crism_info['pixelM']:g} m pixels), stretched min to max in the AOI.",
         "source": credits["crism"], "assumption": False},
        {"id": "science", "file": "overlays/science.png", "label": "Science value",
         "description": "Weighted sum of the normalized CRISM sulfate index and the boxwork ridge score. Weights are assumptions.",
         "source": f"{credits['crism']}; {credits['dem']}", "assumption": True},
        {"id": "shield", "file": "overlays/shield.png", "label": "Terrain sky cover",
         "description": "Where terrain blocks part of the sky (zenith-weighted). Partial shielding only: only the habitat and the rover are full shelters.",
         "source": credits["dem"], "assumption": True},
        {"id": "dem_quality", "file": "overlays/dem_quality.png", "label": "Low-confidence DEM",
         "description": "Cells where a measured test finds stripes that follow the DEM pixel columns (a mosaic artifact, not terrain). Threshold is an assumption.",
         "source": credits["dem"], "assumption": True},
    ]


# ---------------------------------------------------------------- meta.json


def manifest_entry(manifest, key):
    entry = manifest["files"].get(key)
    if entry is None:
        raise RuntimeError(f"{key} is not in data/manifest.json")
    return entry


def build_sources(manifest, crism_info):
    keys = {
        "dem": ("Elevation (1 m DEM)", "data/raw/dem_aoi.tif"),
        "ortho": ("Orthophoto basemap", "data/raw/ortho_aoi.tif"),
        "crism": ("CRISM summary parameters", f"data/raw/crism/{crism_info['file']}"),
        "themis": ("THEMIS day IR", "data/raw/themis_day_aoi.tif"),
        "waypoints": ("Curiosity stops (location map)", "data/raw/msl_waypoints.json"),
    }
    sources = []
    for source_id, (label, key) in keys.items():
        entry = manifest_entry(manifest, key)
        sources.append({"id": source_id, "label": label, "credit": entry["credit"], "url": entry["url"]})
    sources.append(dict(RAD_SOURCE))
    return sources


def row_status(text):
    # "ASSUMPTION (derived from two SOURCED values)" is an assumption: our choice, built from sourced inputs.
    for status in ROW_STATUSES:
        if status in text:
            return status
    raise RuntimeError(f"docs/assumptions.md: unknown status {text!r}")


def assumption_table(text):
    """Every named row of docs/assumptions.md as {name: {value, status, source}} (docs/data-contract.md, section 2).

    Covers the pipeline, engine and model rows, so the app can tag every ASSUMPTION from one table.
    """
    table = {}
    for name, value, status, source in ASSUMPTION_ROW.findall(text):
        if name in table:
            raise RuntimeError(f"docs/assumptions.md: {name} has two rows")
        table[name] = {"value": value.strip(), "status": row_status(status), "source": source.strip()}
    return table


def build_notes(grids, crism_info):
    quality = grids["quality"].astype(bool)
    width = quality.shape[1]
    strip_cols = int(round(DEM_EAST_STRIP_M / ROUTING_CELL_SIZE_M))
    strip_share = quality[:, width - strip_cols:].mean()
    elsewhere_share = quality[:, :width - strip_cols].mean()
    return [
        {"id": "dem_east_strip",
         "text": f"DEM quality: the east {DEM_EAST_STRIP_M} m of the area showed stripe and seam signs in a Phase 0 check. "
                 f"A measured test (stripes that follow the DEM pixel columns) marks {strip_share:.0%} of that strip and "
                 f"{elsewhere_share:.1%} of the rest of the area as low confidence. "
                 "Slopes there can be wrong. The test threshold is an assumption."},
        {"id": "dem_fallback",
         "text": "The USGS DEM uses CTX or HRSC elevation where HiRISE stereo is missing. Those parts are smoother, so small steep features can be missing."},
        {"id": "boulder_floor",
         "text": "Boulders smaller than about 1.5 m cannot be seen in HiRISE images. The boulder layer misses them."},
        {"id": "thermal_brightness",
         "text": "THEMIS layer: image brightness at about 163 m per pixel, not calibrated temperature. Display only."},
        {"id": "crism_resolution",
         "text": f"CRISM sulfate index ({crism_info['band']}) has about {crism_info['pixelM']:g} m pixels: one value covers many routing cells."},
        {"id": "shield_edge",
         "text": "Terrain sky cover counts the sky beyond the edge of the area as open. Terrain gives partial shielding only."},
        {"id": "ortho_grayscale",
         "text": "Part of the west edge of the orthophoto is grayscale: HiRISE color is missing there. It is not an error."},
        {"id": "rover_access",
         "text": "Rover pickup zones are flat areas the crew can walk to. Rover driving access to them is not modeled (assumption)."},
    ]


def point(cell):
    return {"col": int(cell[1]), "row": int(cell[0])}


def build_waypoints(config, sites, site_dir, manifest):
    assignments = config.get("pov_assignments") or {}
    waypoint_credit = manifest_entry(manifest, "data/raw/msl_waypoints.json")["credit"]
    waypoints = []
    for stop in sites["stops"]:
        pov, credit = None, None
        file_name = assignments.get(stop["id"])
        if file_name:
            key = f"app/public/sites/{config['site']}/pov/{file_name}"
            if not (site_dir / "pov" / file_name).exists():
                raise RuntimeError(f"pov_assignments: {key} does not exist")
            entry = manifest_entry(manifest, key)
            # Stop ids follow the selection order. If the stops change, an old assignment would show the wrong place.
            if entry.get("sol") is not None and entry["sol"] != stop["sol"]:
                raise RuntimeError(f"pov_assignments: {file_name} is from sol {entry['sol']}, but {stop['id']} is sol {stop['sol']}")
            pov, credit = f"pov/{file_name}", entry["credit"]
        waypoints.append({
            **point(stop["cell"]), "id": stop["id"], "name": f"Curiosity stop, sol {stop['sol']}",
            "scienceValue": stop["scienceValue"], "sol": stop["sol"], "roverSite": stop["roverSite"],
            "roverDrive": stop["roverDrive"], "source": waypoint_credit, "pov": pov, "povCredit": credit,
        })
    return waypoints


def prune_pov(site_dir, waypoints):
    """Delete the web copies of Curiosity images that no stop uses (docs/datasets.md, Curiosity images).

    The originals stay in data/raw/pov/, and fetch_data.py makes a missing web copy again.
    """
    pov_dir = site_dir / "pov"
    if not pov_dir.exists():
        return 0
    used = {Path(w["pov"]).name for w in waypoints if w["pov"]}
    unused = [path for path in pov_dir.glob("*.jpg") if path.name not in used]
    for path in unused:
        path.unlink()
    return len(unused)


def write_site(site_dir, config, grids, sites, grid_transform, crs_wkt, crism_info, manifest):
    site_dir.mkdir(parents=True, exist_ok=True)
    height, width = grids["cost"].shape
    write_layers(site_dir, grids)

    sources = build_sources(manifest, crism_info)
    credits = {s["id"]: s["credit"] for s in sources}
    tiles, tile_count = write_tiles(Path(__file__).resolve().parent.parent / "data" / "raw" / "ortho_aoi.tif", site_dir / "tiles")
    tiles["source"] = credits["ortho"]
    overlays = write_overlays(site_dir, grids, crism_info, credits)

    t = grid_transform
    meta = {
        "version": CONTRACT_VERSION,
        "site": config["site"],
        "name": config["name"],
        "width": width,
        "height": height,
        "cellSizeMeters": ROUTING_CELL_SIZE_M,
        "crs": rasterio.crs.CRS.from_wkt(crs_wkt).to_proj4(),
        "transform": [t.a, t.b, t.c, t.d, t.e, t.f],
        "bounds": {"west": t.c, "south": t.f + t.e * height, "east": t.c + t.a * width, "north": t.f},
        "byteOrder": "little",
        "rowOrder": "north_to_south",
        "noData": NO_DATA_FLOAT,
        "layers": {
            "elevation": {"file": "elevation.bin", "type": "float32", "units": "m (areoid)"},
            "terrainCost": {"file": "terrain_cost.bin", "type": "uint8", "scale": 0.1, "impassable": 255},
            "shield": {"file": "shield.bin", "type": "uint8"},
            "scienceValue": {"file": "science_val.bin", "type": "uint8"},
            "demQuality": {"file": "dem_quality.bin", "type": "uint8", "values": {"0": "normal", "1": "low_confidence"}},
        },
        "tiles": tiles,
        "overlays": overlays,
        "habitat": {**point(sites["habitat"]), "source": sites["habitatSource"]},
        "shelters": [
            {"id": "habitat", **point(sites["habitat"]), "kind": "full"},
            {"id": "rover", **point(sites["rover"]), "kind": "full", "source": sites["roverSource"]},
        ],
        "roverPickupZones": [{"id": p["id"], **point(p["cell"]), "areaM2": p["areaM2"]} for p in sites["pickups"]],
        "waypoints": build_waypoints(config, sites, site_dir, manifest),
        "sources": sources,
        "notes": build_notes(grids, crism_info),
        "constants": assumption_table(ASSUMPTIONS_PATH.read_text(encoding="utf-8")),
    }
    (site_dir / "meta.json").write_text(json.dumps(meta, indent=2), encoding="utf-8", newline="\n")
    pruned = prune_pov(site_dir, meta["waypoints"])
    print(f"wrote meta.json, 5 layers, {len(overlays)} overlays, {tile_count} tiles; removed {pruned} unused pov images", flush=True)
