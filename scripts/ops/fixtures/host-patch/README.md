# host-patch collector fixtures (#469 stage 2)

Captured on the production host 2026-10-08 (`tmp/capture-469-s2.sh`, read-only):
- `needrestart-b.txt` — `needrestart -b -r l` as root via `systemd-run` (exit 0).
- `livepatch-status.json` — `canonical-livepatch status --format json` via `systemd-run` (exit 0); `Machine-Id` zeroed.
- `apt-list-upgradable.txt` — `apt list --upgradable`; 53 packages, none from a `-security` pocket.

Composed by hand (no live example existed on the capture day):
- `needrestart-b-stale.txt` — a newer installed kernel and a stale `litestream.service`.
- `apt-list-upgradable-security.txt` — two `-security` candidates (spec claim C17, medium).
