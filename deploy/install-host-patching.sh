#!/usr/bin/env bash
# #469 stage 1 — the host patches itself.
# Spec: docs/superpowers/specs/2026-10/2026-10-06-469-host-patching-design.md
#
# Run from the repo root:   sudo bash deploy/install-host-patching.sh
#
# Makes unattended-upgrades patch Node (nodesource node_24.x — never another
# major) and cloudflared (Cloudflare's own apt repo), and refuses to run when
# needrestart would not restart the production units after a library upgrade.
# Idempotent; safe to re-run.
#
# It does NOT attach Ubuntu Pro (that needs the operator's personal token) and
# it never reboots — both are human steps, see deploy/README.md "Host patching".
#
# Every check runs before anything is written: a refused run changes nothing.
#
# WBB_HOST_ROOT is for tests only: every path is taken under it.
set -euo pipefail

R="${WBB_HOST_ROOT:-}"
if [ "$(id -u)" != 0 ] && [ -z "$R" ]; then
  echo "ERROR: run as root: sudo bash deploy/install-host-patching.sh" >&2
  exit 1
fi

# needrestart must restart these by itself (spec C1; stage 2 watches the same set).
WATCHED_UNITS=(warsaw-beer-bot cloudflared litestream ssh)

CF_KEY_URL=https://pkg.cloudflare.com/cloudflare-public-v2.gpg
# Probed 2026-10-06: this primary key verifies pkg.cloudflare.com/cloudflared/dists/any/InRelease.
CF_KEY_FPR=CC94B39C77AE7342A68B89628A682D308D4E5E73
CF_KEYRING=/usr/share/keyrings/cloudflare-public-v2.gpg
CF_LIST=/etc/apt/sources.list.d/cloudflared.list
UU_CONF=/etc/apt/apt.conf.d/52wbb-unattended-upgrades

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# --- 1. needrestart guard -----------------------------------------------------
problems=()
if [ ! -f "$R/etc/needrestart/needrestart.conf" ]; then
  problems+=("needrestart is not installed (no /etc/needrestart/needrestart.conf) — nothing would restart services after a library upgrade")
fi
for f in "$R/etc/needrestart/needrestart.conf" "$R"/etc/needrestart/conf.d/*.conf; do
  [ -f "$f" ] || continue
  live=$(sed -e 's/#.*$//' "$f")
  # Under unattended-upgrades only mode 'a' restarts services: 'l' lists, and 'i'
  # (interactive) falls back to listing when there is no terminal.
  mode=$(sed -nE "s/.*\\\$nrconf\{restart\}[[:space:]]*=[[:space:]]*['\"]([^'\"]*)['\"].*/\1/p" <<< "$live" | tail -n 1)
  if [ -n "$mode" ] && [ "$mode" != a ]; then
    problems+=("$f sets needrestart restart mode to '$mode' — under unattended-upgrades that is list-only, services would never be restarted")
  fi
  # A configured UI switches off the APT-hook default of restarting automatically.
  if grep -qE "\\\$nrconf\{ui\}[[:space:]]*=" <<< "$live"; then
    problems+=("$f configures a needrestart UI — that disables the automatic restart default, leaving list-only under unattended-upgrades")
  fi
  for u in "${WATCHED_UNITS[@]}"; do
    # The unit name followed by anything that cannot continue a unit name:
    # qr(^ssh) and qr(^ssh\.service$) name ssh; qr(^sshd-keygen) does not.
    if grep -qE "qr\(\^?${u}([^A-Za-z0-9_@-]|$)" <<< "$live"; then
      problems+=("$f has a needrestart rule that names $u — it would not be restarted after a library upgrade")
    fi
  done
done
if [ "${#problems[@]}" -gt 0 ]; then
  printf 'ERROR: %s\n' "${problems[@]}" >&2
  echo "Nothing was changed." >&2
  exit 1
fi

# --- 2. fetch and verify the Cloudflare key ------------------------------------
curl -fsSL "$CF_KEY_URL" -o "$work/key.gpg"
mkdir -m 700 "$work/gnupg"
if ! keys=$(GNUPGHOME="$work/gnupg" gpg --show-keys --with-colons "$work/key.gpg"); then
  echo "ERROR: gpg could not read the key from $CF_KEY_URL. Nothing was changed." >&2
  exit 1
fi
# The fingerprint of each primary key is the fpr record right after its pub record.
primaries=$(awk -F: '$1=="pub"{want=1; next} $1=="fpr" && want {print $10; want=0}' <<< "$keys")
count=$(grep -c . <<< "$primaries" || true)
if [ "$count" != 1 ]; then
  echo "ERROR: $CF_KEY_URL holds $count primary keys, expected exactly 1 — refusing to trust it. Nothing was changed." >&2
  exit 1
fi
if [ "$primaries" != "$CF_KEY_FPR" ]; then
  echo "ERROR: $CF_KEY_URL has fingerprint $primaries, expected $CF_KEY_FPR — refusing to trust it. Nothing was changed." >&2
  exit 1
fi

# --- 3. write ------------------------------------------------------------------
cat > "$work/uu.conf" <<'EOF'
// Managed by warsaw-beer-bot deploy/install-host-patching.sh (#469). Do not edit by hand.
// Origins-Pattern, not Allowed-Origins: nodesource publishes "Origin: . nodistro".
Unattended-Upgrade::Origins-Pattern {
  "site=deb.nodesource.com,n=nodistro";
  "site=pkg.cloudflare.com,o=cloudflared";
};
EOF
printf 'deb [signed-by=%s] https://pkg.cloudflare.com/cloudflared any main\n' "$CF_KEYRING" > "$work/cloudflared.list"

install -d "$R/etc/apt/apt.conf.d" "$R/usr/share/keyrings" "$R/etc/apt/sources.list.d"
install -m 0644 "$work/key.gpg"         "$R$CF_KEYRING"
install -m 0644 "$work/cloudflared.list" "$R$CF_LIST"
install -m 0644 "$work/uu.conf"          "$R$UU_CONF"

# --- 4. move cloudflared onto the repo -----------------------------------------
# Upgrades the orphaned .deb in place; the tunnel unit and credentials are untouched.
DEBIAN_FRONTEND=noninteractive apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y cloudflared

echo
echo "== installed =="
echo "  $UU_CONF"
echo "  $CF_KEYRING ($CF_KEY_FPR)"
echo "  $CF_LIST"
echo
echo "Next (deploy/README.md, Host patching): check with"
echo "  sudo unattended-upgrade --dry-run -d 2>&1 | grep -E 'Allowed origins|nodejs|cloudflared'"
