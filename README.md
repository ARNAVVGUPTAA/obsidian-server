# Self-Hosted Obsidian Sync (WebDAV + Cloudflare Tunnel)

A headless WebDAV server for Obsidian sync plugins that speak WebDAV (Remotely Save, for example), exposed to the internet through a Cloudflare tunnel at `obsidian.arnavgupta.dpdns.org`.

No desktop environment and no Obsidian install on the server — Obsidian runs on your devices and syncs to this endpoint.

## Architecture

```
Obsidian client (desktop / iOS / Android)
        |  HTTPS
        v
Cloudflare edge  ->  tunnel  ->  cloudflared container
                                      |  http://webdav:8080
                                      v
                                webdav container  ->  ./data
```

The WebDAV container publishes no host ports. The only route in is the tunnel, so there is nothing to open on the firewall and no inbound port on the box.

## Setup

### 1. Create the tunnel

In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared**. Name it, then copy the token from the install command it shows you (the long `eyJ...` string).

Under **Public Hostnames**, add:

| Field | Value |
| --- | --- |
| Subdomain | `obsidian` |
| Domain | `arnavgupta.dpdns.org` |
| Service type | `HTTP` |
| URL | `webdav:8080` |

`webdav` is the Compose service name — cloudflared resolves it over the shared Docker network, so this works without publishing any ports. Cloudflare creates the DNS record for you.

### 2. Configure

```bash
cp .env.example .env
openssl rand -base64 24   # use this as WEBDAV_PASSWORD
```

Fill in `WEBDAV_PASSWORD` and `TUNNEL_TOKEN` in `.env`. The server refuses to start on a default or empty password.

### 3. Run

```bash
docker compose up -d --build
```

Verify:

```bash
docker compose ps                          # both containers healthy/running
docker compose logs -f cloudflared         # look for "Registered tunnel connection"
curl https://obsidian.arnavgupta.dpdns.org/healthz
```

Expected: `{"status":"ok"}`

Check auth is live:

```bash
curl -u obsidian:YOUR_PASSWORD -X PROPFIND \
  -H 'Depth: 1' https://obsidian.arnavgupta.dpdns.org/
```

That should return `207 Multi-Status` XML. Without `-u`, a `401`.

## Obsidian client setup

Install **Remotely Save** in Obsidian, choose WebDAV, and set:

- Server address: `https://obsidian.arnavgupta.dpdns.org/`
- Username / password: your `WEBDAV_USERNAME` / `WEBDAV_PASSWORD`
- Depth header: `depth_1` (this server supports it)

The trailing slash matters. Run *Check Connectivity* in the plugin before the first sync.

CORS for Obsidian's app origins (`app://obsidian.md`, `capacitor://localhost`, `http://localhost`) is handled in [server.js](server.js#L14-L20) — mobile clients need it, and it's the usual reason a working desktop sync fails on phone. Add more with `ALLOWED_ORIGINS` in `.env`.

## Things worth knowing before you rely on this

**Upload size cap.** Cloudflare's free plan rejects request bodies over 100 MB, and that applies to proxied tunnel traffic. Notes are fine; a large attachment (video, big PDF) in your vault will fail to sync with a `413`. Pro raises it to 100 MB, Business 200 MB, Enterprise higher. If you need big files, sync them out of band or use a `cloudflared` TCP route with `cloudflared access` on the client instead of the public hostname.

**Don't put Cloudflare Access in front of this hostname.** Access expects an interactive browser login; a WebDAV client can't complete that flow and will just get redirected into HTML it can't parse. Basic auth over the tunnel's TLS is the protection here — which is why the password check is enforced at startup. If you want more, add a Cloudflare WAF rate-limiting rule on the hostname rather than Access.

**Back up `./data`.** It's a plain directory of your vault files, owned by uid 1000 on the host. Nothing in this stack is a backup — a `rm` on a client syncs through. Snapshot it on a schedule.

**Restic/borg-style history is absent.** Remotely Save has no version history. Consider a `git` repo inside the vault, or periodic `tar` snapshots of `./data`.

## Operations

```bash
docker compose logs -f webdav        # request log: ip, method, path, status
docker compose restart webdav
docker compose down                  # stop both
docker compose up -d --build         # after changing server.js
```

The request log uses `CF-Connecting-IP` when present, so you see real client IPs rather than the tunnel's.

## Local testing without the tunnel

Uncomment the `ports:` block in [docker-compose.yml](docker-compose.yml#L16-L18), then:

```bash
docker compose up -d --build webdav
curl http://localhost:8080/healthz
```
