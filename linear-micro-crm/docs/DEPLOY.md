# Put Linear Hub on the internet (HTTPS)

Linear Hub runs happily on a laptop for phones on the same hotspot. To use it from anywhere — a rep at a different
site, a leader at home, a phone on 4G — it has to live on a server with a proper address and **HTTPS**. Without HTTPS
the email, employee ID, PIN and session cookie would cross the internet in plain text.

There are two good routes:

| Route | What you run | About per month (October 2026, check before buying) | Best when |
| --- | --- | --- | --- |
| **A. A small VPS + Caddy** | One Linux server you control; Caddy gets and renews the certificate | **€4–6** (Hetzner CX22 in Germany or Finland, about €4.50 with an IPv4 address; DigitalOcean, Vultr or Linode in London, about $5–6) | You want the lowest cost, UK/EU hosting and full control |
| **B. Fly.io or Render** | The repository's `Dockerfile` on a managed platform with a persistent disk | **Fly.io about $4–6** (one shared-CPU machine with 512 MB in London plus a 1 GB volume); **Render about $7.25** (Starter instance plus a 1 GB disk, Frankfurt) | You would rather not look after a server |

Add a domain name for either route (about £10 a year for a `.co.uk`), and off-site backup storage (pennies a month for
a database this size: Backblaze B2, a Hetzner Storage Box from about €3.20, or any S3-compatible bucket).

Whatever the route, Linear Hub keeps everything in **one SQLite file**, so it runs as **exactly one copy** with one
disk. Never scale it out to two machines.

---

## Before you start (both routes)

1. **Decide where the data comes from.** On first start Linear Hub creates and seeds the **demo** data. To go live with
   the people, gauges and pay you already have, bring your existing database: stop Linear Hub on the laptop
   (`npm run stop`, or `npm run service:uninstall` if it runs as a service), make a fresh backup (`npm run backup`), and
   copy two files up to the server: `server/data/linear.sqlite` and `server/data/app-secret`.
2. **The key for two-step secrets.**
   - New install: generate a key once and keep it in your password manager: `openssl rand -hex 32`. Set it as
     `LM_APP_SECRET`.
   - Moving an existing database: keep using its `app-secret` file (set `LM_APP_SECRET_FILE` to where you put it and do
     **not** set `LM_APP_SECRET`), or everyone with two-step verification would be locked out.
3. **Environment for a real deployment** (both routes):

   ```ini
   NODE_ENV=production
   NODE_NO_WARNINGS=1
   TZ=Europe/London
   PORT=4000
   LM_DEMO_ACCOUNTS=0      # the sign-in page shows no demo accounts and the API never publishes a login
   TRUST_PROXY=1           # one reverse proxy in front: honour X-Forwarded-Proto (Secure cookies, HSTS)
   COOKIE_SECURE=1         # the session cookie is only ever sent over HTTPS
   LM_APP_SECRET=…         # or LM_APP_SECRET_FILE=… (see step 2)
   ```

   Never set `LM_BUSINESS_NOW` on a live server (it is for demos and screenshots).

---

## Route A: a small UK/EU VPS with Caddy

The layout: Caddy listens on ports 80 and 443, gets a Let's Encrypt certificate for your domain automatically, and
passes requests to Linear Hub on `127.0.0.1:4000`. Linear Hub itself is never reachable from outside.

### 1. Create the server

- Ubuntu 24.04 LTS, the smallest plan (1–2 vCPU, 1–4 GB RAM is plenty), in London, Germany or Finland.
- Add your SSH key while creating it. Then log in and create a user for the app:

  ```bash
  sudo adduser --system --group --home /opt/linear-hub linear
  sudo mkdir -p /var/lib/linear-hub && sudo chown linear:linear /var/lib/linear-hub && sudo chmod 700 /var/lib/linear-hub
  ```

- Point your domain at it: an `A` record (and `AAAA` for IPv6) for, say, `hub.example.co.uk` → the server's address.

### 2. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status          # 22, 80 and 443 only
```

Also switch on your provider's cloud firewall with the same three ports if it has one, and keep password log-in for SSH
off (`PasswordAuthentication no` in `/etc/ssh/sshd_config`).

### 3. Node.js and the code

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
node -v                  # v22.18 or newer (24 and 26 work too)

sudo -u linear git clone https://github.com/<you>/<repo>.git /opt/linear-hub/app
cd /opt/linear-hub/app/linear-micro-crm
sudo -u linear npm ci --no-audit --no-fund
sudo -u linear npm run build
```

If you are bringing your database, copy it now (from the laptop):

```bash
scp server/data/linear.sqlite server/data/app-secret you@hub.example.co.uk:/tmp/
# on the server:
sudo install -o linear -g linear -m 600 /tmp/linear.sqlite /tmp/app-secret /var/lib/linear-hub/ && rm /tmp/linear.sqlite /tmp/app-secret
```

### 4. The environment file

`/etc/linear-hub.env`, readable by root only (`sudo install -m 600 /dev/null /etc/linear-hub.env`, then edit):

```ini
NODE_ENV=production
NODE_NO_WARNINGS=1
TZ=Europe/London
HOST=127.0.0.1
PORT=4000
DB_PATH=/var/lib/linear-hub/linear.sqlite
LM_BACKUP_DIR=/var/lib/linear-hub/backups
LM_DEMO_ACCOUNTS=0
TRUST_PROXY=1
COOKIE_SECURE=1
# New install:
LM_APP_SECRET=paste-the-openssl-rand-output-here
# Or, when you brought an existing database, instead of LM_APP_SECRET:
# LM_APP_SECRET_FILE=/var/lib/linear-hub/app-secret
```

`HOST=127.0.0.1` keeps Node off the public network: only Caddy can reach it.

### 5. Run it as a service (systemd)

`/etc/systemd/system/linear-hub.service`:

```ini
[Unit]
Description=Linear Hub
After=network-online.target
Wants=network-online.target

[Service]
User=linear
Group=linear
WorkingDirectory=/opt/linear-hub/app/linear-micro-crm/server
EnvironmentFile=/etc/linear-hub.env
ExecStart=/usr/bin/node src/index.ts
Restart=always
RestartSec=5
# Hardening: the app may only write its data folder.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/linear-hub

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now linear-hub
sudo systemctl status linear-hub          # active (running)
curl -s http://127.0.0.1:4000/api/health  # {"ok":true,…}
journalctl -u linear-hub -n 50            # its log
```

(The repository's own `npm run service:install` also works on Linux: it installs a systemd **user** unit for the
account that runs it; add `sudo loginctl enable-linger linear` so it keeps running with nobody logged in. The system
unit above is simpler on a server.)

### 6. Caddy (automatic HTTPS)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddyfile
{
	email you@example.co.uk
}

hub.example.co.uk {
	reverse_proxy 127.0.0.1:4000
	log {
		output file /var/log/caddy/linear-hub.log {
			roll_size 10MiB
			roll_keep 5
		}
	}
}
```

```bash
sudo systemctl reload caddy
```

Caddy fetches the certificate on the first request and renews it by itself; plain `http://` redirects to `https://`.
Linear Hub already compresses its responses and sends the security headers (and HSTS, once `TRUST_PROXY` tells it the
request came over HTTPS), so the Caddyfile needs nothing else. If you prefer Caddy to compress, add `encode zstd gzip`
to the site block and `LM_COMPRESSION=0` to the environment file.

### 7. Backups off the server

Linear Hub already writes a checked copy of the database to `LM_BACKUP_DIR` ten minutes after start and every night
after 02:00 London time, keeping 30 daily and 8 weekly copies (see the README). A copy on the same server does not
survive losing the server, so send them somewhere else every night. With [rclone](https://rclone.org) and an
**encrypted** remote (the folder holds everyone's pay and a copy of the two-step key):

```bash
sudo apt install -y rclone
sudo -u linear rclone config        # add e.g. "b2" (Backblaze B2), then "offsite" of type crypt wrapping b2:linear-hub-backups
sudo -u linear crontab -e
# 03:15 every night: copy the last two days of backups off the server
15 3 * * * rclone copy /var/lib/linear-hub/backups offsite: --max-age 48h --log-file /var/lib/linear-hub/rclone.log
```

**Test a restore** before you rely on it, and again every few months: download one copy to a laptop
(`rclone copy offsite:linear-2026-10-19-0200.sqlite .`), run `npm run restore -- linear-2026-10-19-0200.sqlite` in a
checkout there, start it and check the numbers.

### 8. Updating

```bash
cd /opt/linear-hub/app/linear-micro-crm
sudo -u linear git pull
sudo -u linear npm ci --no-audit --no-fund
sudo -u linear npm run build
sudo systemctl restart linear-hub
```

Database changes apply themselves at start-up (the log says "Upgraded schema: added …"). Take a backup first when the
release notes mention the database:

```bash
cd /opt/linear-hub/app/linear-micro-crm
sudo -u linear env DB_PATH=/var/lib/linear-hub/linear.sqlite LM_BACKUP_DIR=/var/lib/linear-hub/backups npm run backup
```

---

## Route B: Fly.io or Render

Both build the repository's `Dockerfile` (it serves the API and the built client on port 4000 and keeps the database
in `/app/server/data`), so the only things to add are a persistent disk mounted there and the environment.

### Fly.io

```bash
fly launch --no-deploy --region lhr        # London; accept the Dockerfile, say no to databases
fly volumes create linear_data --region lhr --size 1
fly secrets set LM_APP_SECRET="$(openssl rand -hex 32)" LM_DEMO_ACCOUNTS=0 TRUST_PROXY=1 COOKIE_SECURE=1
fly deploy
```

`fly.toml` (the parts that matter):

```toml
app = "linear-hub"
primary_region = "lhr"

[env]
  TZ = "Europe/London"
  PORT = "4000"

[mounts]
  source = "linear_data"
  destination = "/app/server/data"

[http_service]
  internal_port = 4000
  force_https = true
  auto_stop_machines = "off"    # keep it running: the nightly backup and event roll-over run inside the app
  auto_start_machines = true
  min_machines_running = 1

[[http_service.checks]]
  method = "GET"
  path = "/api/health"
  interval = "30s"
  timeout = "5s"
```

- Keep **one machine** (`fly scale count 1`): SQLite lives on that one volume.
- Your own domain: `fly certs add hub.example.co.uk` and the DNS records it prints; Fly issues the certificate.
- Bring your database: `fly ssh sftp shell`, then `put linear.sqlite /app/server/data/linear.sqlite` and
  `put app-secret /app/server/data/app-secret` (set `LM_APP_SECRET_FILE=/app/server/data/app-secret` instead of
  `LM_APP_SECRET` in that case), then `fly machine restart`.
- Backups: Fly snapshots the volume daily (kept 5 days by default), and the app's own copies are in
  `/app/server/data/backups`. Pull one off-site every week: `fly ssh sftp get /app/server/data/backups/<file>`.

### Render

1. **New → Web Service**, connect the repository, root directory `linear-micro-crm`, runtime **Docker**, region
   **Frankfurt (EU)**, instance **Starter** (the free instance has no disk and sleeps).
2. **Disks → Add disk**: mount path `/app/server/data`, 1 GB.
3. **Environment**: `TZ=Europe/London`, `LM_DEMO_ACCOUNTS=0`, `TRUST_PROXY=1`, `COOKIE_SECURE=1`, and
   `LM_APP_SECRET` as a secret (or `LM_APP_SECRET_FILE=/app/server/data/app-secret` when you bring an existing
   database through the **Shell** tab).
4. **Health check path**: `/api/health`. **Custom domain**: add it under Settings; Render issues the certificate.

A service with a disk runs one instance and restarts (a few seconds of downtime) on each deploy. Render keeps daily disk
snapshots for 7 days; still pull a backup off-site every week from the Shell (`ls /app/server/data/backups`).

---

## Go-live checklist

Tick every line before real people use it.

- [ ] **HTTPS**: `https://hub.example.co.uk` shows the padlock and `http://` redirects to it.
- [ ] **Firewall**: only 22, 80 and 443 are open (`sudo ufw status`); `curl http://<server-ip>:4000` from your laptop
      fails (Route A).
- [ ] **Proxy and cookies**: `TRUST_PROXY=1` and `COOKIE_SECURE=1`; `curl -sI https://hub.example.co.uk/api/health`
      shows `Strict-Transport-Security`.
- [ ] **`LM_DEMO_ACCOUNTS=0`**: the sign-in page shows no demo accounts.
- [ ] **`LM_APP_SECRET` set** (or the `app-secret` file in place) and saved in your password manager.
- [ ] **PIN required**: you set your own PIN (Settings → Security → Sign-in PIN), then switched on **Require a PIN for
      everyone** under Sign-in rules. Everyone creates one at their next tap.
- [ ] **Two-step for administrators**: your own two-step verification is on, then **Require two-step verification for
      administrators** is on.
- [ ] **Session idle timeout** chosen (Sign-in rules; 12 hours by default, shorter for shared phones).
- [ ] **Backups tested**: the off-site copy runs every night and you restored one on a laptop (write the date here:
      ________).
- [ ] **No demo data**: the dashboard shows your own people (you brought `linear.sqlite`), not the seeded demo.
- [ ] **Monitoring** (optional, free): an uptime check on `https://hub.example.co.uk/api/health` that emails you.
- [ ] **`npm run doctor`** on the server (Route A) reports nothing to fix.
