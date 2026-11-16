"""Export browser-readable JPL ephemerides while keeping SPK files local."""

import argparse
import json
import os
from contextlib import closing
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from tempfile import NamedTemporaryFile
from urllib.request import urlopen

import numpy as np
from skyfield.api import load, load_file
from skyfield.planetarylib import PlanetaryConstants

ROOT = Path(__file__).resolve().parent
KERNELS = ROOT / "kernels"
OUTPUT = ROOT / "dist" / "data"
SPK_URL = "https://ssd.jpl.nasa.gov/ftp/eph/planets/bsp/"
ORBIT_START = date(1550, 1, 1)
ORBIT_END = date(2550, 12, 31)
LANDING_START = date(1900, 1, 1)
LANDING_END = date(2049, 11, 1)
SKY_END = date(2049, 12, 2)
ORBIT_STEP_H = 24
SKY_STEP_H = 6
SUN_RADIUS_KM = 695700
MOON_RADIUS_KM = 1737.4


def midnight(day):
    return datetime.combine(day, time(), tzinfo=UTC)


def write_bytes(path, data):
    """Replace each completed export without exposing a partially written file."""
    with NamedTemporaryFile("wb", dir=path.parent, delete=False) as file:
        temp = Path(file.name)
        try:
            file.write(data)
            file.close()
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)


def get_kernel(directory, filename):
    path = directory / filename
    if path.is_file():
        return path

    directory.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {filename} from NASA JPL", flush=True)
    with NamedTemporaryFile("wb", dir=directory, delete=False) as file:
        temp = Path(file.name)
        try:
            with urlopen(SPK_URL + filename, timeout=60) as response:
                while block := response.read(1024 * 1024):
                    file.write(block)
            file.close()
            os.replace(temp, path)
        finally:
            temp.unlink(missing_ok=True)
    return path


def export_chunks(label, timescale, start, end, years, step, guard, calculate):
    """Store float32 little-endian rows in independently loadable date blocks."""
    chunks = []
    cursor = start
    while cursor < end:
        stop = min(date(cursor.year + years, 1, 1), end)
        first = max(midnight(start), midnight(cursor) - timedelta(hours=guard * step))
        last = min(midnight(end), midnight(stop) + timedelta(hours=guard * step))
        n = round((last - first).total_seconds() / 3600 / step) + 1
        times = timescale.utc(first.year, first.month, first.day, first.hour + step * np.arange(n))
        rows = np.asarray(calculate(times), dtype="<f4", order="C")
        if rows.shape[0] != n or not np.isfinite(rows).all():
            raise ValueError(f"Invalid {label} samples at {first:%Y-%m-%d}")
        filename = f"{label}-{cursor.year}.bin"
        write_bytes(OUTPUT / filename, rows.tobytes())
        chunks.append({
            "file": filename,
            "start": cursor.isoformat(),
            "end": stop.isoformat(),
            "origin": first.isoformat(),
            "rows": n,
        })
        cursor = stop
    return chunks


def orbit_rows(eph, times):
    earth = (eph["earth"] - eph["sun"]).at(times)
    moon = (eph["moon"] - eph["earth"]).at(times)
    return np.column_stack((earth.xyz.au.T, earth.velocity.au_per_d.T,
                            moon.xyz.au.T, moon.velocity.au_per_d.T))


def sky_rows(eph, frame, times):
    # The browser subtracts the surface observer's fixed position before resolving ENU.
    rotations = frame.rotation_at(times)
    observer = eph["moon"].at(times)
    vectors = [
        np.einsum("ijn,jn->ni", rotations, observer.observe(eph[body]).apparent().xyz.km)
        for body in ("sun", "earth")
    ]
    return np.column_stack(vectors)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spk-dir", type=Path, default=KERNELS, help="Local cache for DE421 and DE440")
    args = parser.parse_args()
    OUTPUT.mkdir(parents=True, exist_ok=True)

    ts = load.timescale(builtin=True)
    constants = PlanetaryConstants()
    for name in ("moon_080317.tf", "pck00008.tpc"):
        constants.read_text((KERNELS / name).open("rb"))
    constants.read_binary((KERNELS / "moon_pa_de421_1900-2050.bpc").open("rb"))
    frame = constants.build_frame_named("MOON_ME_DE421")

    print("Exporting DE421 lunar sky", flush=True)
    with closing(load_file(str(get_kernel(args.spk_dir, "de421.bsp")))) as eph:
        sky = export_chunks("sky", ts, LANDING_START, SKY_END, 5, SKY_STEP_H, 2,
                            lambda t: sky_rows(eph, frame, t))

    print("Exporting DE440 Sun–Earth–Moon orbit", flush=True)
    with closing(load_file(str(get_kernel(args.spk_dir, "de440.bsp")))) as eph:
        orbit = export_chunks("orbit", ts, ORBIT_START, ORBIT_END, 10, ORBIT_STEP_H, 1,
                              lambda t: orbit_rows(eph, t))

    terrain = (KERNELS / "terrain_profiles.json").read_bytes()
    json.loads(terrain)
    write_bytes(OUTPUT / "terrain_profiles.json", terrain)
    metadata = {
        "format": 1,
        "moonRadiusKm": MOON_RADIUS_KM,
        "sunRadiusKm": SUN_RADIUS_KM,
        "sky": {"min": LANDING_START.isoformat(), "max": LANDING_END.isoformat(),
                "end": SKY_END.isoformat(), "stepHours": SKY_STEP_H, "width": 6, "chunks": sky},
        "orbit": {"min": ORBIT_START.isoformat(), "max": ORBIT_END.isoformat(),
                  "end": ORBIT_END.isoformat(), "stepHours": ORBIT_STEP_H, "width": 12, "chunks": orbit},
    }
    write_bytes(OUTPUT / "metadata.json", json.dumps(metadata, separators=(",", ":")).encode())
    print(f"Exported {len(sky)} sky blocks and {len(orbit)} orbit blocks.")


if __name__ == "__main__":
    main()
