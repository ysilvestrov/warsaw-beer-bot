#!/usr/bin/env python3
"""Package the built dist/ into a single loadable .zip (dist contents at the zip root).

Used by `npm run package`. Kept in Python because the host has no `zip` binary and
Node has no stdlib zip writer. The resulting archive, once unzipped, is a folder you
load via chrome://extensions -> Load unpacked.
"""
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXT_ROOT = os.path.dirname(HERE)
DIST = os.path.join(EXT_ROOT, "dist")

with open(os.path.join(EXT_ROOT, "package.json"), encoding="utf-8") as f:
    VERSION = json.load(f)["version"]
OUT = os.path.join(EXT_ROOT, f"warsaw-beer-overlay-{VERSION}.zip")

if not os.path.isdir(DIST):
    sys.exit("dist/ not found — run `npm run build` first (or use `npm run package`).")

if os.path.exists(OUT):
    os.remove(OUT)

count = 0
with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _dirs, files in os.walk(DIST):
        for name in files:
            abs_path = os.path.join(root, name)
            arcname = os.path.relpath(abs_path, DIST)  # dist contents at zip root
            z.write(abs_path, arcname)
            count += 1

print(f"Wrote {OUT} ({count} files, {os.path.getsize(OUT)} bytes)")
