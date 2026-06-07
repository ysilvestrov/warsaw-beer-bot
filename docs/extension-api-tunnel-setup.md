# Browser Extension API — Cloudflare Tunnel setup

How to expose the bot's embedded read-only API (`POST /match`, `GET /health`) at
**`https://beer-api.ysilvestrov-ai.uk`** so the browser extension can reach it.

> **TL;DR:** the box already runs `cloudflared` (the same tunnel that serves
> `code.ysilvestrov-ai.uk`). You do **not** install a new tunnel — you add **one
> public-hostname route** to the existing tunnel, pointing `beer-api` →
> `http://localhost:3000`. No inbound ports are opened; TLS terminates at
> Cloudflare's edge.

---

## 1. How it works

```
extension JS on a shop page (https://...)
        │  fetch  https://beer-api.ysilvestrov-ai.uk/match   (Authorization: Bearer <token>)
        ▼
Cloudflare edge  ── TLS + (optional) WAF ──┐
        │  encrypted tunnel (outbound only) │
        ▼                                   │
cloudflared (systemd, already running) ─────┘
        │  http://127.0.0.1:3000
        ▼
warsaw-beer-bot  →  Hono API (bound to 127.0.0.1:API_PORT)
```

The browser talks only to Cloudflare over HTTPS (so there is no mixed-content
problem). Cloudflare forwards the request through the tunnel to the bot, which
listens on loopback only — the box never opens a public port.

---

## 2. Prerequisites

Check these on the host **before** adding the route:

1. **The merged code is deployed and running.** The API server starts with the
   bot (composition root `src/index.ts`). Deploy via `deploy.sh` and **restart**
   the unit (`enable --now` does not restart a running unit):
   ```bash
   sudo systemctl restart warsaw-beer-bot
   ```
2. **The API is listening on loopback.** Default port is `3000`
   (`API_PORT` in `/etc/warsaw-beer-bot/.env`, optional — defaults to 3000):
   ```bash
   sudo ss -tlnp | grep 127.0.0.1:3000
   # expect a LISTEN line owned by the node process
   curl -s http://127.0.0.1:3000/health        # → {"ok":true}
   ```
   If `/health` does not answer, fix the bot first — the tunnel route will only
   return 502 until the local service responds.
3. **`cloudflared` is up** (it already serves code-server):
   ```bash
   systemctl is-active cloudflared            # → active
   ```

---

## 3. Add the route (recommended: Cloudflare dashboard)

The tunnel is **token-managed** (the unit runs `cloudflared tunnel run --token …`),
so its routing config lives in the Cloudflare **Zero Trust dashboard**, not in a
local `config.yml`. This is the same place the `code.ysilvestrov-ai.uk` route is
defined.

1. Go to **one.dash.cloudflare.com** → select your account.
2. **Networks → Tunnels**. Open the tunnel that already serves
   `code.ysilvestrov-ai.uk` (it should show **HEALTHY**).
3. Open the **Public Hostname** tab → **Add a public hostname**.
4. Fill in:
   | Field | Value |
   |-------|-------|
   | **Subdomain** | `beer-api` |
   | **Domain** | `ysilvestrov-ai.uk` |
   | **Path** | *(leave empty)* |
   | **Type** (service) | `HTTP` |
   | **URL** | `localhost:3000` |
5. (Optional) **Additional application settings → HTTP Settings**: leave defaults.
   Do **not** enable “No TLS Verify” concerns — the origin is plain HTTP on
   loopback, which is correct here (TLS is terminated at the edge), exactly like
   the code-server route (`cert: false`).
6. **Save hostname.**

Cloudflare automatically creates the proxied DNS record
(`beer-api.ysilvestrov-ai.uk` → tunnel, orange-cloud). No manual DNS step.

> The change is picked up by the running `cloudflared` within seconds — **no
> service restart needed**.

---

## 4. Alternative: add the route via the Cloudflare API

Use this only if you prefer scripting over the dashboard. For a token-managed
(remotely-configured) tunnel, the ingress lives in the tunnel **configuration**
object. You need:

- your **Account ID** (Dashboard → any domain → right sidebar, or Zero Trust → Settings),
- the **Tunnel ID** (Networks → Tunnels → the tunnel → “…” → copy ID, or the
  `t` field of the tunnel token),
- a **Cloudflare API token** with the **Account → Cloudflare Tunnel → Edit**
  permission (create at *My Profile → API Tokens*; this is NOT the tunnel run-token).

> ⚠️ Fetch the current config first and edit it — `PUT` **replaces** the whole
> ingress list, so you must include the existing `code.ysilvestrov-ai.uk` rule
> and the trailing `http_status:404` catch-all, plus your new `beer-api` rule.

```bash
ACCOUNT_ID=<account-id>
TUNNEL_ID=<tunnel-id>
CF_API_TOKEN=<api-token-with-tunnel-edit>

# 1) Read the current configuration (so you don't clobber existing routes)
curl -s -X GET \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  -H "Authorization: Bearer $CF_API_TOKEN" | jq .

# 2) PUT the full ingress back, with the new beer-api rule added.
#    Replace the code-server entry below with whatever step 1 returned.
curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{
    "config": {
      "ingress": [
        { "hostname": "code.ysilvestrov-ai.uk", "service": "http://localhost:8080" },
        { "hostname": "beer-api.ysilvestrov-ai.uk", "service": "http://localhost:3000" },
        { "service": "http_status:404" }
      ]
    }
  }'
```

If the DNS record isn't auto-created by this path, add a **proxied CNAME**
`beer-api` → `<TUNNEL_ID>.cfargotunnel.com` (orange cloud) in the
`ysilvestrov-ai.uk` zone.

---

## 5. Verify

From anywhere (the request now goes through Cloudflare):

```bash
# Health endpoint is open
curl -s https://beer-api.ysilvestrov-ai.uk/health
# → {"ok":true}

# /match requires a Bearer token → 401 without one
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST https://beer-api.ysilvestrov-ai.uk/match \
  -H 'Content-Type: application/json' \
  -d '{"beers":[{"brewery":"X","name":"Y"}]}'
# → 401

# With a real token: send /extension to the bot in Telegram, copy the token, then:
TOKEN=<token-from-/extension>
curl -s -X POST https://beer-api.ysilvestrov-ai.uk/match \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"beers":[{"brewery":"Trzech Kumpli","name":"Pan IPAni"}]}' | jq .
# → {"results":[{ "raw":..., "matched_beer":..., "is_drunk":..., "user_rating":... }]}
```

CORS is already permissive (`Access-Control-Allow-Origin: *`) because requests
come from arbitrary shop domains and auth is a header (not a cookie).

---

## 6. Security notes

- **Loopback bind.** The bot binds `127.0.0.1:API_PORT` only; the API is
  reachable *exclusively* through the tunnel. Do not change the bind to `0.0.0.0`.
- **Tokens.** Per-user tokens are minted by `/extension`, rotated 1:1, and stored
  only as SHA-256 hashes. A leaked DB backup exposes no usable tokens.
- **(Optional) Rate limiting at the edge.** If abuse is a concern, add a
  Cloudflare **WAF rate-limiting rule** scoped to `beer-api.ysilvestrov-ai.uk`
  (e.g. N requests/min per IP). Keep it at the edge — the app intentionally has
  no in-process limiter.
- **Do not put this hostname behind Cloudflare Access.** The extension needs to
  call it directly with a Bearer token; an Access login page would block it.

---

## 7. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `502 Bad Gateway` through the tunnel | Bot/API not listening on `127.0.0.1:3000`. Check `ss -tlnp`, `curl 127.0.0.1:3000/health`, `journalctl -u warsaw-beer-bot -f`. |
| `curl https://beer-api…/health` hangs / NXDOMAIN | DNS record not created yet, or wrong subdomain. Confirm the proxied CNAME exists in the `ysilvestrov-ai.uk` zone. |
| Health works, `/match` always 401 | Expected without a token. With a token: confirm it's current (re-run `/extension`; old tokens are revoked on rotation). |
| Extension `fetch` blocked in browser | Must call the **https** hostname (not `http://…:3000`); mixed content is blocked. CORS is `*`, so origin is not the issue. |
| Route added but not taking effect | Token-managed tunnels apply config live; if not, confirm you edited the **correct** tunnel (the HEALTHY one serving code-server) and that `cloudflared` is `active`. |

---

## 8. References

- Spec: `spec.md` §3.11 (`api_tokens`), §4 (HTTP API + `/extension`), §5.9 (deploy).
- Design: `docs/superpowers/specs/2026-06-06-extension-api-token-auth-design.md`.
- Existing pattern on the box: `code.ysilvestrov-ai.uk` → `127.0.0.1:8080`
  (code-server, `cert: false`) — the `beer-api` route mirrors it.
