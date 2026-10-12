#!/bin/sh
# Installed as /usr/local/libexec/wbb-image (root:root 0755) by deploy/install-image.sh; run as root only through
# the fixed rules of /etc/sudoers.d/wbb-image. A copy of deploy/wbb-release.sh's shape for the image helper.
# Plan: docs/superpowers/plans/2026-10/2026-10-12-wbb-image-transition-core.md, "Рішення" п.5.
#
# -I: no PYTHONPATH, no user site, no directory of the caller on sys.path — the library finds its own modules by
# its own path. -B: no bytecode written — root running the helper would leave root-owned __pycache__. Without the
# library this exits 70 (internal error): Python itself would exit 2, and 2 from the root helper means "refused",
# a reading the controller must never get from a missing install.
SCRIPT=/usr/local/lib/wbb-image/wbb_image.py
if [ ! -f "$SCRIPT" ]; then
    echo "wbb-image: $SCRIPT is not installed (sudo bash deploy/install-image.sh)" >&2
    exit 70
fi
# Compiled before it runs: a SyntaxError in the entry script itself (syntax newer than this python3) is raised
# before its own import guard exists, and Python would exit 1 — "bad candidate" from the root helper.
if ! /usr/bin/python3 -I -B -c 'import sys; compile(open(sys.argv[1],"rb").read(), sys.argv[1], "exec")' "$SCRIPT"; then
    echo "wbb-image: $SCRIPT does not compile under /usr/bin/python3" >&2
    exit 70
fi
exec /usr/bin/python3 -I -B /usr/local/lib/wbb-image/wbb_image.py "$@"
