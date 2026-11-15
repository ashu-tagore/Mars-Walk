"""Orbital layers on the routing grid: CRISM sulfate, THEMIS brightness, ridge score, science value.

All functions return float arrays with the grid shape. NaN = no data.
"""

import re
from pathlib import Path

import numpy as np
import rasterio
from rasterio.warp import Resampling, reproject
from scipy import ndimage

from constants import (
    RIDGE_RADIUS_M, SCIENCE_NORMALIZE_HIGH_PERCENTILE, SCIENCE_NORMALIZE_LOW_PERCENTILE,
    SCIENCE_WEIGHT_RIDGE, SCIENCE_WEIGHT_SULFATE,
)

CRISM_SULFATE_BAND = "SINDEX2"  # docs/datasets.md, section 4: sulfate index of the summary-parameter product
CRISM_NO_DATA = 65535


def read_band_names(label_path):
    """Band names from the PDS label. docs/datasets.md: read them, never guess the band order."""
    text = Path(label_path).read_text(encoding="utf-8", errors="replace")
    match = re.search(r"BAND_NAME\s*=\s*\((.*?)\)", text, re.S)
    if not match:
        raise RuntimeError(f"{label_path}: no BAND_NAME list in the label")
    return [name.strip().strip('"') for name in match.group(1).split(",")]


def to_grid(source, band_number, grid_transform, shape, crs_wkt, source_no_data):
    out = np.full(shape, np.nan, dtype=np.float64)
    reproject(
        source=rasterio.band(source, band_number), destination=out,
        src_nodata=source_no_data, dst_nodata=np.nan,
        dst_transform=grid_transform, dst_crs=crs_wkt, resampling=Resampling.bilinear,
    )
    return out


def crism_sulfate(crism_dir, grid_transform, shape, crs_wkt):
    images = sorted(Path(crism_dir).glob("*_su*_mtr3.img"))
    if len(images) != 1:
        raise RuntimeError(f"expected one CRISM summary-parameter image in {crism_dir}, found {len(images)}")
    image = images[0]
    names = read_band_names(image.with_suffix(".lbl"))
    band_number = names.index(CRISM_SULFATE_BAND) + 1
    with rasterio.open(image) as src:
        if src.count != len(names):
            raise RuntimeError(f"{image.name}: {src.count} bands but the label lists {len(names)} names")
        sulfate = to_grid(src, band_number, grid_transform, shape, crs_wkt, CRISM_NO_DATA)
        pixel_m = src.res[0]
    return sulfate, {"file": image.name, "band": CRISM_SULFATE_BAND, "bandNumber": band_number, "pixelM": pixel_m}


def themis_brightness(path, grid_transform, shape, crs_wkt):
    """THEMIS day IR brightness (display only, not temperature). Band 1; bands 2-3 repeat it, band 4 is alpha."""
    with rasterio.open(path) as src:
        thermal = to_grid(src, 1, grid_transform, shape, crs_wkt, None)
    if np.isnan(thermal).any():
        raise RuntimeError("THEMIS clip does not cover the whole grid")
    return thermal


def ridge_score(elevation, cell_m):
    """Height (m) of a cell above the mean of the cells within RIDGE_RADIUS_M. Below the mean = 0.

    Boxwork ridges stand above the hollows between them, so a positive topographic position marks a ridge.
    """
    radius = int(round(RIDGE_RADIUS_M / cell_m))
    offsets = np.arange(-radius, radius + 1)
    disk = (offsets[:, None] ** 2 + offsets[None, :] ** 2) <= radius ** 2
    filled = np.where(np.isnan(elevation), np.nanmean(elevation), elevation)
    neighbourhood_mean = ndimage.convolve(filled, disk / disk.sum(), mode="nearest")
    score = np.maximum(filled - neighbourhood_mean, 0)
    score[np.isnan(elevation)] = np.nan
    return score


def normalize(values):
    """0..1 between the low and high percentiles of the valid values. NaN stays NaN."""
    valid = values[~np.isnan(values)]
    low, high = np.percentile(valid, [SCIENCE_NORMALIZE_LOW_PERCENTILE, SCIENCE_NORMALIZE_HIGH_PERCENTILE])
    if high <= low:
        return np.where(np.isnan(values), np.nan, 0.0)
    return np.clip((values - low) / (high - low), 0, 1)


def science_value(sulfate, ridge):
    """uint8 science value, 0..255. A cell without CRISM data uses the ridge part only (sulfate part = 0)."""
    sulfate_part = np.nan_to_num(normalize(sulfate), nan=0.0)
    ridge_part = np.nan_to_num(normalize(ridge), nan=0.0)
    combined = (SCIENCE_WEIGHT_SULFATE * sulfate_part + SCIENCE_WEIGHT_RIDGE * ridge_part) / (SCIENCE_WEIGHT_SULFATE + SCIENCE_WEIGHT_RIDGE)
    science = np.round(combined * 255).astype(np.uint8)
    science[np.isnan(ridge)] = 0
    return science
