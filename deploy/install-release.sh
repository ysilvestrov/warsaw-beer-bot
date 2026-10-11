#!/usr/bin/env bash
# Stage В core — install the release control plane, switching nothing.
# Plan: docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md, Task 4.
#
# Run from a CLEAN checkout of main:   sudo bash deploy/install-release.sh [--check]
#
# Installs deploy/release into /usr/local/lib/wbb-release, the wbb-release / wbb-tick wrappers and
# wbb-tick-failed, /etc/sudoers.d/wbb-release (visudo-checked) and the wbb-tick units — DISABLED; creates the
# system user wbb-trial and the root-private directories. Never enables, starts or stops a unit, never writes
# under /opt. --check writes nothing and exits 1 on any difference. The work is deploy/release/installer.py.
set -euo pipefail

cd "$(dirname "$0")/.."

if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: run as root: sudo bash deploy/install-release.sh $*" >&2
  exit 1
fi

exec /usr/bin/python3 -I deploy/release/installer.py "$@"
