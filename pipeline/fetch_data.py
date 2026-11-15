"""Phase 0: download and clip all raw data for one site (see docs/datasets.md).

Usage: python fetch_data.py --config ../sites/gale_boxwork.yaml [--only ortho,pov]

Order: AOI, DEM, orthophoto, Curiosity images, CRISM, THEMIS.
Every dataset function returns the output path, or None when it failed.
A failed dataset is logged and the next one still runs. The summary at the
end lists what needs a human decision.

Exit codes: 0 = all required datasets ok, 1 = a required dataset failed,
2 = the AOI center is unknown (ask the human for coordinates).
"""

import argparse
import datetime
import html
import json
import math
import re
import sys
import time
from pathlib import Path

import numpy as np
import rasterio
import requests
import yaml
from PIL import Image
from pyproj import CRS, Transformer
from rasterio.enums import Resampling
from rasterio.env import Env
from rasterio.transform import from_origin
from rasterio.windows import Window, from_bounds

REPO_ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = REPO_ROOT / "data" / "raw"
MANIFEST_PATH = REPO_ROOT / "data" / "manifest.json"

# docs/datasets.md "CRS rule": the same sphere as the USGS products.
MARS_RADIUS_M = 3396190
LONLAT_PROJ = f"+proj=longlat +R={MARS_RADIUS_M} +no_defs"
# Same projection as the DEM and the orthophoto (checked numerically). Matches docs/data-contract.md.
SITE_CRS_PROJ = f"+proj=eqc +lat_ts=0 +lon_0=0 +R={MARS_RADIUS_M} +units=m +no_defs"

DEM_URL = "https://planetarymaps.usgs.gov/mosaic/Mars/MSL/MSL_Gale_DEM_Mosaic_1m_v3.tif"
ORTHO_URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/Mars/MSL/MSL_Gale_HiRISE-LRGB_78quads_sharp_cog.tif"
ORTHO_FALLBACK_URL = "https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/MSL_Gale_Orthophoto_Mosaic_25cm_v3.tif"
# Not in docs/datasets.md as an exact URL: the directory was given, and this file was
# verified to exist and to be a GeoJSON FeatureCollection with sol, lat, lon per point.
WAYPOINTS_URL = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"
# Query format copied from the gallery's own JavaScript (mars.nasa.gov raw-images page).
RAW_IMAGES_API = "https://mars.nasa.gov/api/v1/raw_image_items/"
PHOTOJOURNAL_CATALOG_URL = "https://photojournal.jpl.nasa.gov/catalog/{pia_id}"
ODE_URL = "https://oderest.rsl.wustl.edu/live2/"
THEMIS_LAYER = "Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12_clon0_ly"
THEMIS_CAPS_URL = f"https://api.nasa.gov/mars-wmts/catalog/{THEMIS_LAYER}/1.0.0/WMTSCapabilities.xml"

CREDIT_DEM = "NASA/JPL-Caltech/UArizona; Parker and Calef (2016), USGS Astrogeology"
CREDIT_ORTHO = "NASA/JPL-Caltech/UArizona; Calef and Parker (2016), USGS Astrogeology"
CREDIT_CRISM = "NASA/JPL-Caltech/JHU-APL"
CREDIT_THEMIS = "NASA/JPL-Caltech/ASU"
CREDIT_WAYPOINTS = "NASA/JPL-Caltech (Curiosity location map, MMGIS)"
CREDIT_NAVCAM = "NASA/JPL-Caltech"
CREDIT_MASTCAM = "NASA/JPL-Caltech/MSSS"

# The API names Navcam "NAV_LEFT_B" / "NAV_RIGHT_B" (docs/datasets.md says NAV_LEFT / NAV_RIGHT).
POV_INSTRUMENTS = ["NAV_LEFT_B", "NAV_RIGHT_B", "MAST_LEFT", "MAST_RIGHT"]
POV_PER_PAGE = 100
POV_PAGES_TO_SAMPLE = 20  # pages are spread over the whole sol range, so the images cover all of it
POV_MAX_WIDTH_PX = 1600
STOP_POV_INSTRUMENT = "NAV_LEFT_B"  # left Navcam; the right image of a stereo pair shows almost the same view

# How many sample points per side to estimate footprint overlap (CRISM product choice).
OVERLAP_SAMPLES = 60
# One THEMIS pixel of margin on each side so the later reprojection has no empty edge.
THEMIS_MARGIN_PIXELS = 1

DOWNLOAD_ATTEMPTS = 6
USER_AGENT = "Mozilla/5.0 (compatible; boxwork-eva-navigator-fetch/1.0)"
SESSION = requests.Session()
SESSION.headers["User-Agent"] = USER_AGENT

# Large NASA panoramas exceed Pillow's decompression-bomb limit. The source is trusted.
Image.MAX_IMAGE_PIXELS = None

results = []  # (dataset, status, message) for the end summary


# ---------------------------------------------------------------- small helpers


def log(message):
    print(message, flush=True)


def report(dataset, status, message):
    results.append((dataset, status, message))
    log(f"[{dataset}] {status}: {message}")


def rel(path):
    return Path(path).resolve().relative_to(REPO_ROOT).as_posix()


def as_list(value):
    # ODE returns a dict when there is one item and a list when there are several.
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def today_utc():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")


def get_json(url, params=None):
    last_error = None
    for attempt in range(1, 4):
        try:
            response = SESSION.get(url, params=params, timeout=90)
            response.raise_for_status()
            return response.json()
        except (requests.RequestException, ValueError) as error:
            last_error = error
            time.sleep(2 * attempt)
    raise RuntimeError(f"GET {url} failed: {last_error}")


def remote_size(url):
    try:
        response = SESSION.head(url, allow_redirects=True, timeout=60)
        response.raise_for_status()
        return int(response.headers["Content-Length"])
    except (requests.RequestException, KeyError, ValueError):
        return None


def remote_gdal_env(**extra_options):
    # EMPTY_DIR stops GDAL from listing the remote folder. The extension filter avoids side requests.
    return Env(
        **extra_options,
        GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
        CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif",
        GDAL_HTTP_MAX_RETRY="5",
        GDAL_HTTP_RETRY_DELAY="2",
        GDAL_HTTP_TIMEOUT="120",
        VSI_CACHE="TRUE",
        VSI_CACHE_SIZE=str(256 * 1024 * 1024),
    )


def pixel_window_covering(window):
    # Smallest whole-pixel window that contains a fractional window.
    col0 = math.floor(window.col_off)
    row0 = math.floor(window.row_off)
    col1 = math.ceil(window.col_off + window.width)
    row1 = math.ceil(window.row_off + window.height)
    return Window(col0, row0, col1 - col0, row1 - row0)


# ---------------------------------------------------------------- manifest


def load_manifest():
    if not MANIFEST_PATH.exists():
        return {"files": {}}
    return json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))


def save_manifest(manifest):
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8", newline="\n")


def add_to_manifest(manifest, path, url, credit, **extra):
    size = Path(path).stat().st_size
    old = manifest["files"].get(rel(path))
    # Keep the first download date while the file is unchanged.
    date = old["downloaded_utc"] if old and old["size_bytes"] == size else today_utc()
    manifest["files"][rel(path)] = {
        "url": url,
        "downloaded_utc": date,
        "size_bytes": size,
        "credit": credit,
        **extra,
    }
    save_manifest(manifest)


def is_in_manifest(manifest, path):
    entry = manifest["files"].get(rel(path))
    return Path(path).exists() and entry is not None and entry["size_bytes"] == Path(path).stat().st_size


def clip_is_current(manifest, path, aoi):
    # A clipped file is up to date when it was made for exactly this AOI.
    if not is_in_manifest(manifest, path):
        return False
    return manifest["files"][rel(path)].get("aoi_bounds_m") == aoi["bounds_m"]


# ---------------------------------------------------------------- download with resume


def download_file(url, dest, expected_size=None):
    """Download with resume. Writes dest.part first, then renames, so dest is always complete."""
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    last_error = None

    for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
        have = part.stat().st_size if part.exists() else 0
        if expected_size is not None and have == expected_size:
            break
        headers = {"Range": f"bytes={have}-"} if have else {}
        attempt_failed = False
        try:
            with SESSION.get(url, headers=headers, stream=True, timeout=60) as response:
                if response.status_code == 416:
                    part.unlink()  # the part file is larger than the remote file: start over
                    continue
                response.raise_for_status()
                if have and response.status_code != 206:
                    have = 0  # the server ignored the Range header
                write_stream(response, part, have, expected_size, dest.name)
        except requests.RequestException as error:
            attempt_failed = True
            last_error = error
            log(f"  download interrupted ({error}); retry {attempt}/{DOWNLOAD_ATTEMPTS}")
            time.sleep(min(30, 3 * attempt))
        have = part.stat().st_size if part.exists() else 0
        finished = have == expected_size if expected_size is not None else not attempt_failed
        if finished:
            break
    else:
        raise RuntimeError(f"download of {url} did not finish: {last_error}")

    if expected_size is not None and part.stat().st_size != expected_size:
        raise RuntimeError(f"{dest.name}: size {part.stat().st_size} differs from expected {expected_size}")
    part.replace(dest)
    return dest


def write_stream(response, part, start_byte, expected_size, name):
    done = start_byte
    next_report = done
    report_every = max(1, (expected_size or 500_000_000) // 20)
    with open(part, "ab" if start_byte else "wb") as out:
        for chunk in response.iter_content(chunk_size=1024 * 1024):
            out.write(chunk)
            done += len(chunk)
            if done >= next_report + report_every and expected_size and expected_size > 50_000_000:
                next_report = done
                log(f"  {name}: {done / 1e6:.0f} of {expected_size / 1e6:.0f} MB ({100 * done / expected_size:.0f}%)")


def fetch_one_file(manifest, url, dest, credit, **extra):
    """Download if missing or changed size. Returns the path. Used for small and large files."""
    dest = Path(dest)
    expected = remote_size(url)
    already_complete = dest.exists() and (
        dest.stat().st_size == expected if expected is not None else is_in_manifest(manifest, dest)
    )
    if not already_complete:
        download_file(url, dest, expected)
    add_to_manifest(manifest, dest, url, credit, **extra)
    return dest


# ---------------------------------------------------------------- 0. AOI


def read_center(config):
    lat = config.get("center_lat")
    lon = config.get("center_lon")
    if lat is None or lon is None:
        return None
    return float(lat), float(lon)


def fetch_waypoints(manifest):
    dest = RAW_DIR / "msl_waypoints.json"
    try:
        return fetch_one_file(
            manifest, WAYPOINTS_URL, dest, CREDIT_WAYPOINTS,
            note="Curiosity waypoints. Used to derive the AOI center and to locate candidate images by sol.",
        )
    except Exception as error:
        report("waypoints", "FAILED", str(error))
        return None


def load_waypoints(path):
    features = json.loads(Path(path).read_text(encoding="utf-8"))["features"]
    return [feature["properties"] for feature in features]


def derive_center_from_waypoints(config, config_path, manifest):
    """docs/datasets.md AOI steps 1 to 4. Returns (lat, lon) or None."""
    path = fetch_waypoints(manifest)
    if path is None:
        return None
    sol_min, sol_max = config["aoi_sol_min"], config["aoi_sol_max"]
    selected = [p for p in load_waypoints(path) if sol_min <= p["sol"] <= sol_max]
    if not selected:
        report("aoi", "FAILED", f"no waypoints in sols {sol_min} to {sol_max}")
        return None

    lat = sum(p["lat"] for p in selected) / len(selected)
    lon = sum(p["lon"] for p in selected) / len(selected)
    lat, lon = round(lat, 6), round(lon, 6)
    write_center_to_yaml(config_path, lat, lon, len(selected), sol_min, sol_max)
    log(f"  derived AOI center from {len(selected)} waypoints (sols {sol_min} to {sol_max}): lat {lat}, lon {lon}")
    log(f"  written to {config_path}")
    return lat, lon


def write_center_to_yaml(config_path, lat, lon, count, sol_min, sol_max):
    # Edit the two lines in place so the comments in the YAML survive.
    # Keep the file's own line endings (Windows would otherwise turn LF into CRLF).
    raw = Path(config_path).read_bytes().decode("utf-8")
    newline = "\r\n" if "\r\n" in raw else "\n"
    text = raw.replace("\r\n", "\n")
    derived = f"DERIVED by fetch_data.py: mean of {count} waypoints, sols {sol_min}-{sol_max}. Confirm in QGIS."
    text = re.sub(r"^center_lat:[^\n]*", f"center_lat: {lat}   # degrees, negative = south. {derived}", text, flags=re.M)
    text = re.sub(r"^center_lon:[^\n]*", f"center_lon: {lon}   # degrees east", text, flags=re.M)
    Path(config_path).write_text(text, encoding="utf-8", newline=newline)


def build_aoi(center_lat, center_lon, size_m):
    """AOI box in projected meters, snapped to the 1 m DEM pixel grid so the DEM clip needs no resampling."""
    with remote_gdal_env(), rasterio.open("/vsicurl/" + DEM_URL) as dem:
        to_dem = Transformer.from_crs(CRS.from_proj4(LONLAT_PROJ), CRS.from_wkt(dem.crs.to_wkt()), always_xy=True)
        center_x, center_y = to_dem.transform(center_lon, center_lat)
        pixel = dem.res[0]
        left = dem.bounds.left + round((center_x - size_m / 2 - dem.bounds.left) / pixel) * pixel
        top = dem.bounds.top - round((dem.bounds.top - (center_y + size_m / 2)) / pixel) * pixel
        dem_bounds = dem.bounds
        back = Transformer.from_crs(CRS.from_wkt(dem.crs.to_wkt()), CRS.from_proj4(LONLAT_PROJ), always_xy=True)

    right, bottom = left + size_m, top - size_m
    inside = left >= dem_bounds.left and right <= dem_bounds.right and bottom >= dem_bounds.bottom and top <= dem_bounds.top
    if not inside:
        raise RuntimeError("AOI is outside the DEM mosaic. Check center_lat and center_lon.")

    lon_min, lat_min = back.transform(left, bottom)
    lon_max, lat_max = back.transform(right, top)
    return {
        "center_lat": center_lat,
        "center_lon": center_lon,
        "size_m": size_m,
        "crs_proj4": SITE_CRS_PROJ,
        "bounds_m": [round(left, 3), round(bottom, 3), round(right, 3), round(top, 3)],
        "bounds_lonlat": [round(lon_min, 6), round(lat_min, 6), round(lon_max, 6), round(lat_max, 6)],
    }


def fetch_aoi(config, config_path, manifest):
    """Returns the AOI dict, or None when the center is unknown."""
    center = read_center(config)
    if center is None:
        center = derive_center_from_waypoints(config, config_path, manifest)
    if center is None:
        report("aoi", "NEEDS HUMAN", "No AOI center. Enter center_lat and center_lon (see Mars Trek) in the YAML.")
        return None
    try:
        aoi = build_aoi(center[0], center[1], config["size_m"])
    except Exception as error:
        report("aoi", "FAILED", str(error))
        return None
    manifest["aoi"] = aoi
    save_manifest(manifest)
    report("aoi", "ok", f"center {center[0]}, {center[1]}; bounds_m {aoi['bounds_m']}; bounds lon/lat {aoi['bounds_lonlat']}")
    return aoi


# ---------------------------------------------------------------- 1. DEM


# The DEM is stripped (one row per block). Rows of a stripped file are contiguous, so a
# windowed read only fetches the AOI rows. When those rows are a small share of the file
# this is far cheaper than the full download that docs/datasets.md describes (measured
# here: about 200 MB against 3.6 GB). Above this share the full download is used.
STRIPPED_WINDOW_MAX_FRACTION = 0.10
DEM_ROWS_PER_READ = 250
# Large chunks: the AOI rows are contiguous, so one big request fetches many rows at once.
DEM_GDAL_OPTIONS = {"CPL_VSIL_CURL_CHUNK_SIZE": str(8 * 1024 * 1024)}


def clip_dem_from(source, aoi):
    """Read the AOI window from a local path or a /vsicurl/ URL. Returns (data, profile)."""
    left, bottom, right, top = aoi["bounds_m"]
    with remote_gdal_env(**DEM_GDAL_OPTIONS), rasterio.open(source) as src:
        window = from_bounds(left, bottom, right, top, src.transform)
        window = Window(round(window.col_off), round(window.row_off), round(window.width), round(window.height))
        data = np.empty((window.height, window.width), dtype=src.dtypes[0])
        for row in range(0, window.height, DEM_ROWS_PER_READ):
            rows = min(DEM_ROWS_PER_READ, window.height - row)
            part = Window(window.col_off, window.row_off + row, window.width, rows)
            data[row:row + rows] = src.read(1, window=part)
            log(f"  DEM rows {row + rows} of {window.height}")
        profile = {
            "driver": "GTiff", "dtype": data.dtype, "count": 1, "width": window.width, "height": window.height,
            "crs": src.crs, "transform": src.window_transform(window), "nodata": src.nodata,
            "compress": "deflate", "predictor": 3, "tiled": True, "blockxsize": 256, "blockysize": 256,
        }
    return data, profile


def fetch_dem(aoi, manifest):
    out = RAW_DIR / "dem_aoi.tif"
    if clip_is_current(manifest, out, aoi):
        report("dem", "skipped", f"{rel(out)} already clipped for this AOI")
        return out

    remote_url = "/vsicurl/" + DEM_URL
    with remote_gdal_env(**DEM_GDAL_OPTIONS), rasterio.open(remote_url) as remote:
        is_stripped = remote.block_shapes[0][1] == remote.width
        aoi_row_share = aoi["size_m"] / remote.res[1] / remote.height

    clipped = None
    used = "windowed read of the remote file"
    if not is_stripped or aoi_row_share <= STRIPPED_WINDOW_MAX_FRACTION:
        log(f"  DEM windowed read ({aoi_row_share:.1%} of the file rows). This can take about 30 minutes on a slow server.")
        try:
            clipped = clip_dem_from(remote_url, aoi)
        except Exception as error:
            log(f"  windowed read failed ({error}); falling back to the full download")

    full_path = RAW_DIR / Path(DEM_URL).name
    if clipped is None:
        log("  downloading the full DEM file with resume")
        fetch_one_file(
            manifest, DEM_URL, full_path, CREDIT_DEM,
            note="Full mosaic, kept as a cache so a changed AOI needs no new download. Safe to delete after clipping.",
        )
        clipped = clip_dem_from(str(full_path), aoi)
        used = "local clip of the full download"
    data, profile = clipped

    with rasterio.open(out, "w", **profile) as dst:
        dst.write(data, 1)
    nodata = profile["nodata"]
    valid = data != nodata
    if not valid.any():
        report("dem", "FAILED", "the clipped DEM has only no-data pixels")
        return None
    stats = {
        "shape_px": [data.shape[0], data.shape[1]],
        "elevation_min_m": float(data[valid].min()),
        "elevation_max_m": float(data[valid].max()),
        "nodata_fraction": round(float(1 - valid.mean()), 4),
    }
    add_to_manifest(
        manifest, out, DEM_URL, CREDIT_DEM, aoi_bounds_m=aoi["bounds_m"], method=used,
        human_check="The mosaic uses CTX/HRSC where HiRISE stereo is missing. The human must confirm HiRISE coverage "
                    "in QGIS (a sharp hillshade means HiRISE, a blurry one means the CTX fallback).",
        **stats,
    )
    report("dem", "ok", f"{rel(out)} via {used}; {stats}")
    return out


# ---------------------------------------------------------------- 2. Orthophoto


def clip_ortho_from(url, aoi, out, resolution_m):
    left, bottom, right, top = aoi["bounds_m"]
    out_pixels = round(aoi["size_m"] / resolution_m)
    with remote_gdal_env(), rasterio.open("/vsicurl/" + url) as src:
        outside = left < src.bounds.left or right > src.bounds.right or bottom < src.bounds.bottom or top > src.bounds.top
        if outside:
            raise RuntimeError("AOI is outside this orthophoto mosaic")
        window = from_bounds(left, bottom, right, top, src.transform)
        # out_shape smaller than the window makes GDAL read the COG overview level.
        data = src.read(window=window, out_shape=(src.count, out_pixels, out_pixels), resampling=Resampling.average)
        profile = {
            "driver": "GTiff", "dtype": data.dtype, "count": src.count, "width": out_pixels, "height": out_pixels,
            "crs": src.crs, "transform": from_origin(left, top, resolution_m, resolution_m),
            "compress": "deflate", "tiled": True, "blockxsize": 256, "blockysize": 256,
        }
    with rasterio.open(out, "w", **profile) as dst:
        dst.write(data)


def fetch_ortho(config, aoi, manifest):
    out = RAW_DIR / "ortho_aoi.tif"
    if clip_is_current(manifest, out, aoi):
        report("ortho", "skipped", f"{rel(out)} already clipped for this AOI")
        return out

    resolution_m = config["ortho_resolution_m"]
    for url in (ORTHO_URL, ORTHO_FALLBACK_URL):
        try:
            clip_ortho_from(url, aoi, out, resolution_m)
        except Exception as error:
            log(f"  orthophoto source failed ({url}): {error}")
            continue
        add_to_manifest(
            manifest, out, url, CREDIT_ORTHO, aoi_bounds_m=aoi["bounds_m"], resolution_m=resolution_m,
            human_check="Open in QGIS with dem_aoi.tif: ridges must line up.",
        )
        report("ortho", "ok", f"{rel(out)} from {url.rsplit('/', 1)[-1]} at {resolution_m} m")
        return out
    report("ortho", "FAILED", "both the 0.5 m color COG and the 25 cm fallback failed")
    return None


# ---------------------------------------------------------------- 3. Curiosity images


def query_raw_images(search, page, sol_min, sol_max):
    # Parameter names are the ones the gallery page itself sends.
    params = {
        "order": "sol asc", "per_page": POV_PER_PAGE, "page": page,
        "condition_1": "msl:mission",
        "condition_2": f"{sol_min}:sol:gte",
        "condition_3": f"{sol_max}:sol:lte",
        "search": search, "extended": "",
    }
    return get_json(RAW_IMAGES_API, params)


def list_pov_candidates(config):
    """Full-frame images spread evenly over the sol range. Same result on every run."""
    sol_min, sol_max = config["aoi_sol_min"], config["aoi_sol_max"]
    search = "|".join(POV_INSTRUMENTS)
    total = query_raw_images(search, 0, sol_min, sol_max)["total"]
    page_count = math.ceil(total / POV_PER_PAGE)
    pages = sorted(set(np.linspace(0, page_count - 1, num=min(POV_PAGES_TO_SAMPLE, page_count)).round().astype(int)))

    by_id = {}
    for page in pages:
        for item in query_raw_images(search, int(page), sol_min, sol_max)["items"]:
            is_full_frame = item["extended"].get("sample_type") == "full" and not item["is_thumbnail"]
            if is_full_frame and item["instrument"] in POV_INSTRUMENTS:
                by_id[item["imageid"]] = item
    candidates = sorted(by_id.values(), key=lambda item: (item["sol"], item["imageid"]))

    wanted = min(config["max_pov_images"], len(candidates))
    if wanted == 0:
        return []
    picks = sorted(set(np.linspace(0, len(candidates) - 1, num=wanted).round().astype(int)))
    log(f"  raw image query: {total} images match, {len(candidates)} full-frame in sampled pages, taking {len(picks)}")
    return [candidates[i] for i in picks]


def nearest_waypoint(waypoints, sol):
    if not waypoints:
        return {}
    best = min(waypoints, key=lambda p: (abs(p["sol"] - sol), -p["drive"]))
    return {"waypoint_rmc": best["RMC"], "waypoint_sol": best["sol"], "waypoint_lat": best["lat"], "waypoint_lon": best["lon"]}


def to_web_jpeg(src_path, dest_path):
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src_path) as img:
        img.draft("RGB", (POV_MAX_WIDTH_PX, POV_MAX_WIDTH_PX))  # lets JPEG decode at reduced size
        img = img.convert("RGB")
        if img.width > POV_MAX_WIDTH_PX:
            height = round(img.height * POV_MAX_WIDTH_PX / img.width)
            img = img.resize((POV_MAX_WIDTH_PX, height), Image.LANCZOS)
        img.save(dest_path, "JPEG", quality=85)


def save_pov(manifest, raw_path, web_path, url, credit, **extra):
    add_to_manifest(manifest, raw_path, url, credit, **extra)
    if not web_path.exists() or web_path.stat().st_mtime < raw_path.stat().st_mtime:
        to_web_jpeg(raw_path, web_path)
    add_to_manifest(manifest, web_path, url, credit, derived_from=rel(raw_path), max_width_px=POV_MAX_WIDTH_PX, **extra)


def save_raw_image(manifest, item, raw_dir, web_dir, **extra):
    """Download one raw-images API item (skip if already in the manifest) and make its web copy."""
    url = item.get("https_url") or item["url"]
    raw_path = raw_dir / f"{item['imageid']}.jpg"
    if not is_in_manifest(manifest, raw_path):
        download_file(url, raw_path)
    credit = item.get("image_credit") or (CREDIT_MASTCAM if item["instrument"].startswith("MAST") else CREDIT_NAVCAM)
    save_pov(
        manifest, raw_path, web_dir / raw_path.name, url, credit,
        image_id=item["imageid"], sol=item["sol"], camera=item["instrument"],
        date_taken_utc=item["date_taken"], sample_type=item["extended"].get("sample_type"),
        rover_site=item.get("site"), rover_drive=item.get("drive"), rover_xyz=item.get("xyz"),
        **extra,
    )


def fetch_raw_images(config, manifest, waypoints, raw_dir, web_dir):
    count = 0
    for item in list_pov_candidates(config):
        try:
            save_raw_image(
                manifest, item, raw_dir, web_dir, kind="curiosity_raw_image",
                location_note="waypoint_* is the Curiosity waypoint closest in sol, not the exact image location.",
                **nearest_waypoint(waypoints, item["sol"]),
            )
            count += 1
        except Exception as error:
            log(f"  image {item['imageid']} failed: {error}")
    return count


def resolve_photojournal(pia_id):
    """The old photojournal.jpl.nasa.gov/tiff/<id>.tif pattern redirects to a landing page.
    Read the real file link and credit line from the catalog page instead."""
    page = SESSION.get(PHOTOJOURNAL_CATALOG_URL.format(pia_id=pia_id), timeout=90)
    page.raise_for_status()
    link = re.search(rf"https://assets\.science\.nasa\.gov/content/dam/[^\"' <>]*{pia_id}\.jpg", page.text)
    credit = re.search(r"Credits:\s*</span>\s*(?:<[^>]+>\s*)*([^<]+)", page.text)
    title = re.search(r"<title>([^<]*)</title>", page.text)
    if link is None or credit is None:
        raise RuntimeError(f"{pia_id}: image link or credit not found on the catalog page")
    title_text = html.unescape(title.group(1)).replace(" - NASA Science", "").strip() if title else pia_id
    return link.group(0), html.unescape(credit.group(1)).strip(), title_text, page.url


def fetch_photojournal(config, manifest, raw_dir, web_dir):
    count = 0
    for pia_id in config.get("photojournal_ids", []):
        try:
            url, credit, title, page_url = resolve_photojournal(pia_id)
            raw_path = raw_dir / f"{pia_id}.jpg"
            if not is_in_manifest(manifest, raw_path):
                download_file(url, raw_path, remote_size(url))
            save_pov(manifest, raw_path, web_dir / raw_path.name, url, credit, kind="photojournal", pia_id=pia_id, title=title, catalog_page=page_url)
            count += 1
        except Exception as error:
            log(f"  {pia_id} failed: {error}")
    return count


def fetch_pov(config, manifest):
    raw_dir = RAW_DIR / "pov"
    web_dir = REPO_ROOT / "app" / "public" / "sites" / config["site"] / "pov"
    waypoints_path = fetch_waypoints(manifest)
    waypoints = load_waypoints(waypoints_path) if waypoints_path else []

    try:
        raw_count = fetch_raw_images(config, manifest, waypoints, raw_dir, web_dir)
    except Exception as error:
        raw_count = 0
        log(f"  Source A (raw images API) failed: {error}")
    pia_count = fetch_photojournal(config, manifest, raw_dir, web_dir)

    total = raw_count + pia_count
    if total == 0:
        report("pov", "FAILED", "no candidate images")
        return None
    report("pov", "ok", f"{raw_count} raw images + {pia_count} Photojournal images in {rel(raw_dir)}")
    return raw_dir


def list_stop_images(stop, per_stop):
    """Full-frame left Navcam images taken at the stop: same sol, rover site and drive.

    Left camera only, because the right image of a stereo pair shows almost the same view.
    The picks are spread evenly over the day's images (sorted by time), so they point in
    different directions. Same result on every run.
    """
    items, page = [], 0
    while True:
        answer = query_raw_images(STOP_POV_INSTRUMENT, page, stop["sol"], stop["sol"])
        items += answer["items"]
        if not answer.get("more"):
            break
        page += 1
    at_stop = [
        item for item in items
        if item["instrument"] == STOP_POV_INSTRUMENT
        and item["extended"].get("sample_type") == "full" and not item["is_thumbnail"]
        and str(item.get("site")) == str(stop["roverSite"]) and str(item.get("drive")) == str(stop["roverDrive"])
    ]
    at_stop.sort(key=lambda item: (item["date_taken"], item["imageid"]))
    if not at_stop:
        return []
    picks = sorted(set(np.linspace(0, len(at_stop) - 1, num=min(per_stop, len(at_stop))).round().astype(int)))
    return [at_stop[i] for i in picks]


def fetch_stop_pov(config, manifest):
    """Navcam images taken at each science stop in meta.json (stops are real Curiosity stops)."""
    meta_path = REPO_ROOT / "app" / "public" / "sites" / config["site"] / "meta.json"
    if not meta_path.exists():
        report("stop_pov", "skipped", "run prepare.py first: the stops come from meta.json")
        return None
    stops = json.loads(meta_path.read_text(encoding="utf-8"))["waypoints"]
    raw_dir = RAW_DIR / "pov"
    web_dir = REPO_ROOT / "app" / "public" / "sites" / config["site"] / "pov"
    per_stop = int(config.get("stop_pov_per_stop", 0))

    counts = []
    for stop in stops:
        count = 0
        for item in list_stop_images(stop, per_stop):
            try:
                save_raw_image(
                    manifest, item, raw_dir, web_dir, kind="curiosity_stop_image",
                    stop_id=stop["id"], stop_sol=stop["sol"],
                    location_note="Taken at the stop: same sol, rover site and drive as the waypoint.",
                )
                count += 1
            except Exception as error:
                log(f"  image {item['imageid']} failed: {error}")
        counts.append(f"{stop['id']} (sol {stop['sol']}): {count}")
    total = sum(int(c.rsplit(": ", 1)[1]) for c in counts)
    if total == 0:
        report("stop_pov", "FAILED", "no images found at the stops")
        return None
    report("stop_pov", "ok", f"{total} Navcam images at the stops in {rel(raw_dir)}; " + ", ".join(counts))
    return raw_dir


# ---------------------------------------------------------------- 4. CRISM


def parse_wkt_rings(wkt):
    rings = []
    for text in re.findall(r"\(([^()]+)\)", wkt or ""):
        points = [tuple(float(v) for v in pair.split()[:2]) for pair in text.split(",")]
        if len(points) >= 3:
            rings.append(points)
    return rings


def point_in_ring(lon, lat, ring):
    inside = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        crosses = (y1 > lat) != (y2 > lat)
        if crosses and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def aoi_overlap_fraction(footprint_wkt, aoi):
    """Share of the AOI inside the footprint, by sampling. AOI is a lon/lat box (equirectangular)."""
    rings = parse_wkt_rings(footprint_wkt)
    if not rings:
        return 0.0
    lon_min, lat_min, lon_max, lat_max = aoi["bounds_lonlat"]
    lons = np.linspace(lon_min, lon_max, OVERLAP_SAMPLES)
    lats = np.linspace(lat_min, lat_max, OVERLAP_SAMPLES)
    hits = 0
    for lon in lons:
        for lat in lats:
            # Even-odd rule over all rings.
            if sum(point_in_ring(lon, lat, ring) for ring in rings) % 2 == 1:
                hits += 1
    return hits / (OVERLAP_SAMPLES * OVERLAP_SAMPLES)


def fetch_crism(aoi, manifest):
    lon_min, lat_min, lon_max, lat_max = aoi["bounds_lonlat"]
    # Parameter names verified in the ODE REST manual V2.1.6 (westlon/eastlon are accepted aliases).
    params = {
        "query": "product", "target": "mars", "ihid": "MRO", "iid": "CRISM", "pt": "MTRDR",
        "minlat": lat_min, "maxlat": lat_max, "westlon": lon_min, "eastlon": lon_max,
        "loc": "f", "results": "mf", "output": "JSON",
    }
    try:
        answer = get_json(ODE_URL, params)["ODEResults"]
        if answer.get("Status") != "Success":
            raise RuntimeError(answer.get("Error", "ODE returned an error"))
        products = as_list((answer.get("Products") or {}).get("Product"))
        scored = sorted(((aoi_overlap_fraction(p.get("Footprint_geometry"), aoi), p["Product_name"], p) for p in products),
                        key=lambda row: (-row[0], row[1]))
        if not scored or scored[0][0] == 0:
            raise RuntimeError("no CRISM MTRDR product covers the AOI")
        overlap, name, product = scored[0]

        wanted = [f for f in as_list(product["Product_files"]["Product_file"])
                  if f["Type"] == "Product" and re.search(r"_SU[0-9A-Z]*_MTR\d\.(IMG|HDR|LBL)$", f["FileName"].upper())]
        if not any(f["FileName"].upper().endswith(".IMG") for f in wanted):
            raise RuntimeError(f"{name}: no summary-parameter (su) IMG file in the product")

        out_dir = RAW_DIR / "crism"
        for file in wanted:
            fetch_one_file(
                manifest, file["URL"], out_dir / file["FileName"].lower(), CREDIT_CRISM,
                product_name=name, observation_time_utc=product.get("Observation_time"), aoi_overlap_fraction=round(overlap, 3),
                ode_product_page=product.get("ProductURL"), footprint_source=product.get("Footprint_souce"),
                note="Summary-parameter file. Read band names from the .lbl. Do not guess band order.",
            )
    except Exception as error:
        report("crism", "FAILED", str(error))
        return None
    report("crism", "ok", f"ODE product {name} covers {overlap:.0%} of the AOI ({len(products)} products found); su files in {rel(out_dir)}")
    return out_dir


# ---------------------------------------------------------------- 5. THEMIS


def prepare_themis_capabilities(manifest):
    """Save the layer's Capabilities file with the tile URL template corrected.

    The template says ".../1.0.0//{Style}/..." (double slash). The server answers 404 for that
    form and 200 for a single slash, and GDAL turns every 404 tile into a black pixel without
    an error. So the file is fixed before GDAL reads it.
    """
    path = RAW_DIR / "themis_wmts_capabilities.xml"
    if is_in_manifest(manifest, path):
        return path
    response = SESSION.get(THEMIS_CAPS_URL, timeout=90)
    response.raise_for_status()
    path.write_text(response.text.replace("/1.0.0//", "/1.0.0/"), encoding="utf-8", newline="\n")
    add_to_manifest(
        manifest, path, THEMIS_CAPS_URL, CREDIT_THEMIS,
        note="WMTS Capabilities. Edited: the double slash in the tile ResourceURL was replaced by a single slash.",
    )
    return path


def fetch_themis(aoi, manifest):
    out = RAW_DIR / "themis_day_aoi.tif"
    if clip_is_current(manifest, out, aoi):
        report("themis", "skipped", f"{rel(out)} already clipped for this AOI")
        return out

    lon_min, lat_min, lon_max, lat_max = aoi["bounds_lonlat"]
    try:
        capabilities = prepare_themis_capabilities(manifest)
        # The GDAL WMTS driver reads only the tiles that cover the window.
        with Env(GDAL_HTTP_MAX_RETRY="5", GDAL_HTTP_RETRY_DELAY="2", GDAL_HTTP_TIMEOUT="120"),                 rasterio.open("WMTS:" + capabilities.as_posix()) as src:
            margin = THEMIS_MARGIN_PIXELS * src.res[0]
            window = from_bounds(lon_min - margin, lat_min - margin, lon_max + margin, lat_max + margin, src.transform)
            window = pixel_window_covering(window)
            data = src.read(window=window)
            profile = {
                "driver": "GTiff", "dtype": data.dtype, "count": src.count, "width": window.width, "height": window.height,
                "crs": src.crs, "transform": src.window_transform(window), "compress": "deflate",
            }
            pixel_deg = src.res[0]
        # GDAL fills tiles it could not download with zeros and reports no error.
        if data.max() == 0:
            raise RuntimeError("THEMIS read returned only zeros: the tile requests failed")
        with rasterio.open(out, "w", **profile) as dst:
            dst.write(data)
    except Exception as error:
        report("themis", "FAILED", str(error))
        return None

    meters_per_pixel = pixel_deg * math.pi / 180 * MARS_RADIUS_M
    add_to_manifest(
        manifest, out, THEMIS_CAPS_URL, CREDIT_THEMIS, aoi_bounds_m=aoi["bounds_m"], layer=THEMIS_LAYER,
        shape_px=[data.shape[1], data.shape[2]], bands=int(data.shape[0]), pixel_size_deg=pixel_deg,
        pixel_size_m=round(meters_per_pixel, 1), brightness_min=int(data.min()), brightness_max=int(data.max()),
        note="Display overlay only, not a routing input. Values are image brightness, not calibrated temperature. "
             "Pixels are in lon/lat degrees; layers.py reprojects onto the DEM grid.",
    )
    report("themis", "ok", f"{rel(out)} {data.shape[2]} x {data.shape[1]} px at about {meters_per_pixel:.0f} m/pixel, brightness {data.min()} to {data.max()}")
    return out


# ---------------------------------------------------------------- main


ALL_DATASETS = ["dem", "ortho", "pov", "crism", "themis", "stop_pov"]
# stop_pov needs the stops from meta.json (prepare.py), so it runs only when named in --only.
DEFAULT_DATASETS = ["dem", "ortho", "pov", "crism", "themis"]
REQUIRED = {"dem", "ortho", "pov"}


def check_done(manifest):
    """The 'Done when' list of Phase 0 in docs/build-plan.md."""
    log("\nPhase 0 checks")
    dem, ortho = RAW_DIR / "dem_aoi.tif", RAW_DIR / "ortho_aoi.tif"
    if dem.exists() and ortho.exists():
        with rasterio.open(dem) as a, rasterio.open(ortho) as b:
            same = all(abs(x - y) < 1e-3 for x, y in zip(a.bounds, b.bounds))
        log(f"  dem_aoi.tif and ortho_aoi.tif exist, same bounds: {'yes' if same else 'NO'}")
    else:
        log("  dem_aoi.tif and ortho_aoi.tif: missing")
    pov_count = len(list((RAW_DIR / "pov").glob("*.jpg"))) if (RAW_DIR / "pov").exists() else 0
    log(f"  candidate POV images in data/raw/pov: {pov_count} (need at least 5)")
    missing = [path for path in manifest["files"] if not (REPO_ROOT / path).exists()]
    log(f"  manifest lists {len(manifest['files'])} files; missing on disk: {len(missing)}")


def print_summary(manifest):
    log("\n==== Summary ====")
    for dataset, status, message in results:
        log(f"{dataset:10s} {status:12s} {message}")
    check_done(manifest)
    log("\nHUMAN STEPS")
    log("  1. Confirm the AOI center (lat/lon in the YAML). It was derived from waypoints, not read from Mars Trek.")
    log("  2. Open data/raw/dem_aoi.tif and data/raw/ortho_aoi.tif in QGIS. Ridges must line up.")
    log("     The DEM hillshade must be sharp (HiRISE), not blurry (CTX fallback).")
    log("  3. Pick which Curiosity images go to which waypoint (candidates: data/raw/pov and app/public/sites/<site>/pov).")


def main():
    # The console may use a legacy code page. Titles from NASA pages contain non-ASCII characters.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Download and clip the raw data for one site.")
    parser.add_argument("--config", required=True, help="path to sites/<site>.yaml")
    parser.add_argument("--only", help=f"comma-separated subset of: {','.join(ALL_DATASETS)}")
    args = parser.parse_args()

    config_path = Path(args.config).resolve()
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    selected = args.only.split(",") if args.only else DEFAULT_DATASETS
    unknown = [name for name in selected if name not in ALL_DATASETS]
    if unknown:
        parser.error(f"unknown dataset(s): {unknown}")

    RAW_DIR.mkdir(parents=True, exist_ok=True)
    manifest = load_manifest()

    aoi = fetch_aoi(config, config_path, manifest)
    if aoi is None:
        print_summary(manifest)
        return 2

    optional = config.get("optional", {})
    steps = {
        "dem": lambda: fetch_dem(aoi, manifest),
        "ortho": lambda: fetch_ortho(config, aoi, manifest),
        "pov": lambda: fetch_pov(config, manifest),
        "crism": lambda: fetch_crism(aoi, manifest) if optional.get("crism") else report("crism", "disabled", "optional.crism is false"),
        "themis": lambda: fetch_themis(aoi, manifest) if optional.get("themis") else report("themis", "disabled", "optional.themis is false"),
        "stop_pov": lambda: fetch_stop_pov(config, manifest),
    }
    for name in ALL_DATASETS:
        if name not in selected:
            continue
        try:
            steps[name]()
        except Exception as error:
            report(name, "FAILED", f"{type(error).__name__}: {error}")

    print_summary(manifest)
    required_failed = any(status == "FAILED" and dataset in REQUIRED for dataset, status, _ in results)
    return 1 if required_failed else 0


if __name__ == "__main__":
    sys.exit(main())
