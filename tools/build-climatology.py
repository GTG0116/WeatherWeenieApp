"""Builds the climatologies used by the anomaly products.

Source: NCEP/NCAR Reanalysis 1991-2020 monthly long-term means (NOAA PSL)
  https://downloads.psl.noaa.gov/Datasets/ncep.reanalysis.derived/pressure/air.mon.ltm.1991-2020.nc
  https://downloads.psl.noaa.gov/Datasets/ncep.reanalysis.derived/pressure/hgt.mon.ltm.1991-2020.nc

Output (public/data/clim/), int16 little-endian laid out [month][level][lat][lon]:
  air_ltm.bin / .json   temperature, degC * 100
  hgt_ltm.bin / .json   geopotential height, m

Usage: python tools/build-climatology.py <dir-with-air-and-hgt-ltm-files>
Requires h5py and numpy. The generated files are checked in, so this only
needs re-running to refresh the climatology.
"""
import json
import os
import sys

import h5py
import numpy as np

LEVELS = [1000, 925, 850, 700, 600, 500, 400, 300, 250, 200, 150, 100, 50, 10]
VARIABLES = {
    # name: (file, scale, units)
    "air": ("air.mon.ltm.1991-2020.nc", 100, "degC*100"),
    "hgt": ("hgt.mon.ltm.1991-2020.nc", 1, "m"),
}

src_dir = sys.argv[1]
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = os.path.join(root, "public", "data", "clim")
os.makedirs(out, exist_ok=True)

for name, (filename, scale, units) in VARIABLES.items():
    f = h5py.File(os.path.join(src_dir, filename), "r")
    data_all = f[name][:]  # (12, 17, 73, 144)
    src_levels = [int(x) for x in f["level"][:]]
    lat = f["lat"][:]
    lon = f["lon"][:]
    data = data_all[:, [src_levels.index(l) for l in LEVELS], :, :]
    if np.any(np.abs(data) > 1e6):
        raise SystemExit(f"unexpected missing values in {name}")
    packed = np.round(data * scale)
    if packed.min() < -32768 or packed.max() > 32767:
        raise SystemExit(f"{name} does not fit in int16")
    packed.astype("<i2").tofile(os.path.join(out, f"{name}_ltm.bin"))
    meta = {
        "source": "NCEP/NCAR Reanalysis 1991-2020 monthly long-term mean (NOAA PSL)",
        "units": units,
        "scale": scale,
        "dtype": "int16le",
        "layout": "[month][level][lat][lon]",
        "levels": LEVELS,
        "nlat": int(lat.size),
        "nlon": int(lon.size),
        "lat0": float(lat[0]),
        "dlat": float(lat[1] - lat[0]),
        "lon0": float(lon[0]),
        "dlon": float(lon[1] - lon[0]),
    }
    with open(os.path.join(out, f"{name}_ltm.json"), "w") as fh:
        json.dump(meta, fh, indent=2)
    print("wrote", name, packed.shape)
