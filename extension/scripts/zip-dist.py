#!/usr/bin/env python3
"""Package the built dist/ into a single loadable .zip (dist contents at the zip root).

Used by `npm run package`. Kept in Python because the host has no `zip` binary and
Node has no stdlib zip writer. The resulting archive, once unzipped, is a folder you
load via chrome://extensions -> Load unpacked.

The archive is DETERMINISTIC: entries are sorted and written with a fixed timestamp and
mode, so identical dist/ contents always produce a byte-identical zip (stable sha256).
Override the source dir / output path via ZIP_DIST_SRC / ZIP_DIST_OUT (used by tests).
"""
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXT_ROOT = os.path.dirname(HERE)

with open(os.path.join(EXT_ROOT, "package.json"), encoding="utf-8") as f:
    VERSION = json.load(f)["version"]

DIST = os.environ.get("ZIP_DIST_SRC", os.path.join(EXT_ROOT, "dist"))
OUT = os.environ.get(
    "ZIP_DIST_OUT", os.path.join(EXT_ROOT, f"warsaw-beer-overlay-{VERSION}.zip")
)

FIXED_DATE = (1980, 1, 1, 0, 0, 0)  # zip epoch floor — stable across runs

if not os.path.isdir(DIST):
    sys.exit(f"{DIST} not found — run `npm run build` first (or use `npm run package`).")

if os.path.exists(OUT):
    os.remove(OUT)

entries = []
for root, _dirs, files in os.walk(DIST):
    for name in files:
        abs_path = os.path.join(root, name)
        arcname = os.path.relpath(abs_path, DIST)  # dist contents at zip root
        entries.append((arcname, abs_path))
entries.sort()  # deterministic entry order

with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for arcname, abs_path in entries:
        with open(abs_path, "rb") as fh:
            data = fh.read()
        info = zipfile.ZipInfo(filename=arcname, date_time=FIXED_DATE)
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, data)

print(f"Wrote {OUT} ({len(entries)} files, {os.path.getsize(OUT)} bytes)")
