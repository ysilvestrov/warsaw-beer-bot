#!/bin/sh
# Installed as /usr/local/libexec/wbb-release (root:root 0755) by deploy/install-release.sh; run as root only through
# the fixed rules of /etc/sudoers.d/wbb-release (`audit` runs without sudo, as the operator).
# Plan: docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md, "Рішення" п.5.
#
# -I: no PYTHONPATH, no user site, no directory of the caller on sys.path — the library finds its own modules by
# its own path. Without the library this exits 70 (internal error): Python itself would exit 2, and 2 from the root
# helper means "refused", a reading the controller must never get from a missing install.
SCRIPT=/usr/local/lib/wbb-release/wbb_release.py
if [ ! -f "$SCRIPT" ]; then
    echo "wbb-release: $SCRIPT is not installed (sudo bash deploy/install-release.sh)" >&2
    exit 70
fi
exec /usr/bin/python3 -I /usr/local/lib/wbb-release/wbb_release.py "$@"
