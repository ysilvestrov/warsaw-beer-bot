#!/bin/sh
# Installed as /usr/local/bin/wbb-tick (root:root 0755) by deploy/install-release.sh; run as the operator, by
# wbb-tick.service (`wbb-tick timer`) or by hand (`wbb-tick deploy --target <sha>`, `rearm`, `ack-baseline`).
# Plan: docs/superpowers/plans/2026-10/2026-10-11-wbb-artifact-deployment-c-install-core.md, "Рішення" п.5.
#
# -I -B as in wbb-release.sh. Without the library this exits 71: the tick did not start and told nobody, which
# wbb-tick-failed reports (the unit's SuccessExitStatus=0 1 2 would take Python's own 1 or 2 for a tick's answer).
SCRIPT=/usr/local/lib/wbb-release/tick.py
if [ ! -f "$SCRIPT" ]; then
    echo "wbb-tick: $SCRIPT is not installed (sudo bash deploy/install-release.sh)" >&2
    exit 71
fi
# Compiled before it runs (e2e review S2): a SyntaxError in the entry script itself (syntax newer than this
# python3) is raised before its own import guard exists, and Python would exit 1 —
# a success for the tick's unit, so nobody would be told.
if ! /usr/bin/python3 -I -B -c 'import sys; compile(open(sys.argv[1],"rb").read(), sys.argv[1], "exec")' "$SCRIPT"; then
    echo "wbb-tick: $SCRIPT does not compile under /usr/bin/python3" >&2
    exit 71
fi
exec /usr/bin/python3 -I -B /usr/local/lib/wbb-release/tick.py "$@"
