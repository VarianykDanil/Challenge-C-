# Put Linear Hub online

Linear Hub runs for real on **one small Linux server of Linear MCR's own**, in the UK or EU, at an address of the
company's own (for example `https://hub.linear-mcr.co.uk`), with HTTPS. Reps then use it on 4G at any venue, it keeps
running when the office laptop is shut, and its backups leave the building every night.

This page is the runbook for that: what to buy, the go-live day step by step (the owner with Noryn), the go-live
checklist, and everyday running. The installer `deploy/install.sh` does the technical part in one run.

The office Mac on Wi-Fi is **for the trial only**: see [Trial only: the office Mac](#trial-only-the-office-mac) at the
end.

---

## 1. First the agreement, then what to buy in Linear MCR's name

**The agreement comes first.** The agreement signed for the trial covers Linear Hub on the office Mac. Going online,
with HTTPS, is outside it (Schedule 1, Part 2, 2.1(a)): Noryn quotes it as a **fixed-price go-live package**, and both
companies sign a **variation** under clause 26.2 before go-live day, as clause 9.3 requires. The variation:

- names the server and off-site storage providers and where the server is (a server in Germany or Finland holds the
  data outside the UK, so it is also Linear MCR's written instruction for that, Schedule 3, 3.6);
- says who looks after the server, its updates and the off-site copies: moved into the monthly service, or kept by
  Linear MCR, which the agreement makes responsible for them today (clauses 9.2 and 16.5);
- replaces Schedules 3 and 4 for a server on the internet: where the data is processed, HTTPS, the firewall, Noryn's
  SSH access, and the owner's duties for the server instead of the Mac (Schedule 4, Part 4).

Buying the accounts in Linear MCR's name keeps their providers Linear MCR's own (Schedule 3, 3.4). A provider Noryn
engaged itself would be a new sub-processor, with 30 days' notice first (Schedule 3, 3.2). Nothing goes on the internet
until the variation is signed.

Buy each of these **in Linear MCR's name and with its card**, so the company owns its data and its address. Noryn gets
access to look after them (an SSH key on the server), not ownership.

| What | Suggested | About (October 2026; check before buying) |
| --- | --- | --- |
| **A small server (VPS)** | Ubuntu 24.04 LTS, 2 vCPU, 4 GB memory, 40 GB disk or more. For example a Hetzner Cloud CX22 in Germany or Finland, or a London VPS from DigitalOcean, Vultr or Linode | €4–6 a month (Hetzner, with an IPv4 address); about $6–12 a month in London |
| **The address** | A subdomain of the company's domain, e.g. `hub.linear-mcr.co.uk` | Nothing extra if you own the domain; a new `.co.uk` is about £10 a year |
| **Off-site storage** | A Hetzner Storage Box (1 TB, in a different location from the server), or any S3-compatible bucket (Hetzner Object Storage, Backblaze B2, AWS S3 London) | About €4 a month; a bucket costs pennies at this size |
| **Monitoring** (free) | An uptime check (UptimeRobot or Better Stack) and a heartbeat check for the nightly copy (Healthchecks.io) | Free plans are enough |

The server holds everything: one SQLite database file plus the folders beside it. It runs as **exactly one copy**.
Never run two servers on the same data.

## 2. How it fits together

```
phone ──https──▶ Caddy (ports 80/443, gets and renews the certificate)
                   └─▶ Linear Hub on 127.0.0.1:4000 (not reachable from outside)
                         └─▶ /var/lib/linear-hub/linear.sqlite and the folders beside it

02:00  Linear Hub backs up the database and the uploaded files, checks the copy, and writes an encrypted copy
       (linear-….lhbk, locked with the off-site passphrase) into /var/lib/linear-hub/offsite
03:15  the off-site timer copies the new encrypted files to the Storage Box or bucket (it never deletes anything there)
```

| Where | What |
| --- | --- |
| `/opt/linear-hub/app` | The code (a git checkout; the app is in `linear-micro-crm/`) |
| `/var/lib/linear-hub` | The data: `linear.sqlite`, `backups/`, `offsite/`, `media/` (videos), `statements/`, `uploads/`, `logs/errors.log` |
| `/etc/linear-hub/linear-hub.env` | The settings (readable by root only) |
| `/etc/linear-hub/keys/app-secret` | The **app key**: it locks bank details, two-step sign-in and PINs. It goes on the **recovery sheet** |
| `/etc/linear-hub/keys/backup-passphrase` | The **off-site passphrase**: it locks the off-site copies. It goes on **separate paper** |
| `/etc/caddy/Caddyfile` | The HTTPS front door |
| `/usr/local/bin/linear-hub` | The command for everyday jobs (`sudo linear-hub help`) |
| Logs | `sudo linear-hub logs`, `/var/lib/linear-hub/logs/errors.log`, `/var/log/caddy/linear-hub.log` |

The key and the passphrase live **outside** the data folder on purpose: a copy of the data folder, or of its backups,
cannot unlock bank details on its own.

---

## 3. Go-live day, step by step

About half a day, the owner with Noryn. Before you start: the variation for going online is signed (§1), the Mac runs
Linear Hub 1.5 (`npm run latest` in the Linear Hub folder) and the trial has gone well.

### Step 1 — Buy the server

1. Create the account in Linear MCR's name (Hetzner: **Cloud → New project "Linear Hub" → Add server**).
2. Choose **Ubuntu 24.04**, the location (Germany or Finland; or London with another provider) and the size above.
3. Add Noryn's **SSH key** (Noryn sends it) and, if you like, your own. Do not choose password log-in.
4. Write down the server's **IPv4 address** (and IPv6, if shown).

### Step 2 — Point the address at it

At the company that holds your domain, add a DNS record:

| Type | Name | Value |
| --- | --- | --- |
| `A` | `hub` | the server's IPv4 address |
| `AAAA` (if the server has IPv6) | `hub` | the server's IPv6 address |

It usually works within minutes, sometimes an hour. `ping hub.linear-mcr.co.uk` then shows the server's address.

### Step 3 — Order the off-site storage

- **Hetzner Storage Box** (simplest): order it in a **different location** from the server. In its settings, turn on
  **SSH support** and **automatic snapshots** (for example one a day). Write down its host (`u123456.your-storagebox.de`)
  and user (`u123456`). Keep its password to type once in step 4.
- **Or an S3-compatible bucket:** make a **private** bucket with **versioning** on (and object lock, if the provider
  offers it), and an access key that can use only that bucket. Keep the endpoint, the bucket's **region** (for AWS,
  the part after `s3.` in the endpoint, e.g. `eu-west-2`; the installer works it out for AWS, Hetzner and Backblaze
  addresses and asks otherwise), the bucket name, the access key ID and the secret key for step 4.

**Why snapshots or versioning.** The server's copy job never deletes anything off-site, but the login it uses could:
someone who took over the server could delete or overwrite the copies with it. Snapshots and versions are kept by the
storage provider, out of that login's reach.

**How long copies are kept** is Linear MCR's decision, written into the variation: the copies hold personal data, so
no longer than needed; **90 days** is a sensible start. On a bucket, a lifecycle rule deletes copies (and old versions)
older than that. On a Storage Box, snapshots expire by themselves; the `backups` folder itself grows by one encrypted
copy a night, so whoever looks after the server clears copies older than the retention at the monthly backup check
(`rclone delete --min-age 90d`), always keeping the newest month whatever else happens.

### Step 4 — Run the installer (Noryn, about 20 minutes)

From a computer with the Linear Hub code on it:

```bash
scp -r linear-micro-crm/deploy root@<server address>:/root/
ssh root@<server address>
bash /root/deploy/install.sh
```

It asks:

1. the web address (`hub.linear-mcr.co.uk`) and an email for certificate notices;
2. the code repository and the release to install (Noryn's private repository, a release tag such as `v1.5.0`;
   for a private repository it shows a key to add on GitHub as a read-only deploy key);
3. where the off-site copies go: **1** Storage Box, **2** S3-compatible bucket, **3** an rclone remote set up
   already, **4** nowhere yet (it warns you that copies then stay on the server);
4. an address to ping after each good off-site copy (a Healthchecks.io check, see step 9; it can be added on a later
   run, but go-live needs it);
5. whether to turn off password log-in for SSH (only offered when you log in with a key).

Then it works on its own: system packages, a 2 GB swap file on servers with under 2 GB of memory, automatic security
updates, the firewall (SSH, 80 and 443 only), Node.js 22 LTS, the `linear` service user and its folders, the code and
the build, the app key, the off-site passphrase, the settings file, the locked-down service, Caddy and HTTPS, the
nightly off-site copy and the `linear-hub` command.

**It shows the off-site passphrase once.** Write it on paper there and then, and type its last group of five to show
it is written down. Keep that paper **apart from** the recovery sheet (step 7): someone who finds one should not find
the other. The passphrase is not in the install log.

For a Storage Box, it first records the box's SSH host keys and shows their fingerprints: compare them with the ones
Hetzner publishes for Storage Boxes, and stop if they differ. Then it puts the server's key on the box: type the
Storage Box password once when asked (it is not stored). Run with `--yes` (no questions), it cannot type that
password: it shows the server's public key instead. Add that key to the Storage Box as Hetzner's guide to Storage Box
SSH keys describes, then run the installer again.

At the end it prints the address, the health check address and the next steps. Open `https://hub.linear-mcr.co.uk`:
the sign-in page with a padlock. (If the address does not answer yet, the DNS is not through: Caddy keeps trying by
itself. `sudo linear-hub status` shows where it stands.)

The same run without questions, for Noryn's notes:

```bash
S3_SECRET_ACCESS_KEY='…' bash /root/deploy/install.sh --yes \
  --domain hub.linear-mcr.co.uk --email ops@example.co.uk \
  --repo git@github.com:<noryn>/<linear-hub>.git --ref v1.5.0 \
  --offsite s3 --s3-endpoint https://… --s3-bucket … --s3-access-key-id …
```

Running it again is safe: it keeps the app key, the passphrase, the database and your extra settings, and changes only
what is missing or different. Answers are kept in `/etc/linear-hub/install.conf`.

### Step 5 — Bring the trial database across

On the **Mac**, in Terminal, in the Linear Hub folder:

```bash
npm run stop                     # or, if it runs in the background:  npm run service:uninstall
npm run backup -- --new-passphrase ~/linear-move-passphrase.txt      # a one-off passphrase for the move
mkdir -p ~/linear-move
LM_OFFSITE_DIR=~/linear-move LM_BACKUP_PASSPHRASE_FILE=~/linear-move-passphrase.txt LM_BACKUP_VIDEOS=1 npm run backup
scp ~/linear-move/linear-*.lhbk root@<server address>:/root/
```

That makes **one encrypted file** holding the database, the uploaded files, the learning videos and the trial's app
key, and copies it to the server. Then, **on the server**:

```bash
sudo linear-hub import /root/linear-2026-11-02-1400.lhbk      # the file name the Mac printed
```

It asks for the **move passphrase** (in `~/linear-move-passphrase.txt` on the Mac) and to confirm. The new server
started with a fresh demo of its own: if the restore lists payments or paid weeks it would forget, they are that
demo's, so type **RESTORE**. It puts the trial's database, files and app key in place (the server's own new key is kept
aside as `app-secret.before-restore-…`, never deleted) and starts Linear Hub again.

(Noryn may copy the passphrase file across too and run
`sudo linear-hub import /root/linear-….lhbk --passphrase-file /root/linear-move-passphrase.txt` instead of typing it;
delete that file from the server afterwards.)

Then on the Mac: `rm -r ~/linear-move ~/linear-move-passphrase.txt`. Leave Linear Hub **stopped** on the Mac from now
on, so nobody keeps using the old copy.

### Step 6 — Go live

```bash
sudo linear-hub golive
```

It shows what goes (the demo company: its people, one-tap accounts and records) and what stays (your settings, your
own people and everything they made), asks for the first owner's name and email if none of your own administrators
is left, and asks you to type **GO LIVE**. It backs the database up and checks the backup before changing anything.
If it made the first owner, it prints their **one-time setup code**.

### Step 7 — The owner signs in and prints the recovery sheet

1. On your phone or laptop, open `https://hub.linear-mcr.co.uk`. Sign in with your email, employee ID and setup code,
   and set up two-step verification with your authenticator app. Keep the recovery codes somewhere safe, away from the
   phone.
2. **The recovery sheet is made on the server, never in the app** (the key never travels over the network). Noryn
   and the owner, over SSH: `sudo linear-hub recovery-sheet` shows the sheet; copy the key onto the paper by hand
   (16 groups of 4), with the fingerprint and the folders it lists. Then `sudo linear-hub recovery-sheet --confirm`
   and the owner types the **whole key** back from the paper: a copying mistake is caught here, before the backups stop
   keeping their copy of the key. **Settings › Backups › App key and recovery** then says "Printed and kept".
3. Lock the sheet away like a bank card, away from the server and **apart from the passphrase paper**. Without the
   key, bank details, two-step sign-in and PINs cannot be read again.
4. **Settings › Security › Sign-in rules:** choose when people are signed out (14 hours after signing in by default,
   4 to 24) and the idle time (12 hours by default); switch on **Require a PIN** if you want one.

### Step 8 — Test the off-site copy and a restore

```bash
sudo linear-hub backup          # a backup now, with its encrypted copy
sudo linear-hub offsite-sync    # copy it off the server now ("Result: ok …")
sudo linear-hub restore-test    # download the newest off-site copy, open it, start it, check it, delete it
```

`restore-test` ends with **"Restore test passed"** and the number of people and gauge entries in the copy. Write the
date in the checklist below. If it fails, stop and tell Noryn: the backups are not proven yet.

### Step 9 — Monitoring (free)

- **Uptime:** in UptimeRobot (or Better Stack), add an HTTP(s) monitor for `https://hub.linear-mcr.co.uk/api/health`,
  every 5 minutes, with the keyword `"ok":true`. Alerts go to the owner and to Noryn.
- **Nightly copy:** in Healthchecks.io, add a check with a period of 1 day and a grace of 6 hours. Give its ping
  address to the installer (`bash /root/deploy/install.sh --heartbeat-url https://hc-ping.com/…`): it is pinged
  only after a good off-site copy, so a night that fails sends you an email.
- Inside Linear Hub, administrators also see **System health** in the bell: a failed backup, a late encrypted copy, a
  disk nearly full, the key not on paper yet, server errors. The bell sees the encrypted copies **on the server**; a
  nightly copy to the Storage Box or bucket that fails shows only in `sudo linear-hub status` and through this
  heartbeat. So the heartbeat is **not optional** for go-live: the installer warns at the end of every run until it
  has one.

### Step 10 — Phones

1. For each person: **Team → their name → Edit profile → Sign-in setup → Give a setup code** (needs your own
   two-step code). Hand the code over privately (in person or by text, never in a group chat). People added from now
   on get theirs in **Sign-in details** when they are added.
2. On the phone: open `https://hub.linear-mcr.co.uk`, sign in with the work email, employee ID and setup code, and set
   up the authenticator app (about two minutes).
3. **Add to Home Screen** (iPhone: Share → Add to Home Screen; Android: the menu → Install app). It then opens like an
   app, and once opened it opens again without signal and keeps saves until the signal is back.
4. Charity and client contacts: the invite on their campaign page carries their access code and setup code.

### Step 11 — Payments, when you are ready

**Settings → Payments** walks through the first run: a connection in test mode, a sandbox payment (or the 1p test
file for a bank file), then live (type PAY FOR REAL), then one person, then everyone. See
[`OWNER_NOTES_1.4.md`](OWNER_NOTES_1.4.md).

### Step 12 — Retire the trial Mac

Once the restore test has passed: on the Mac, `npm run service:uninstall` (if it ran in the background) and delete the
Linear Hub data folder (`server/data`): it holds personal data that now lives on the server.

---

## 4. Go-live checklist

Tick every line before real people use it.

- [ ] **The variation for going online** is signed by both companies (§1), and the go-live package agreed.
- [ ] **Bought in Linear MCR's name:** the server, the domain and the off-site storage (snapshots or versioning on).
- [ ] **HTTPS:** `https://<address>` shows the padlock and `http://<address>` redirects to it.
- [ ] **Firewall:** `sudo ufw status` shows only SSH, 80 and 443; `curl http://<server-ip>:4000` from another computer
      fails.
- [ ] **Settings:** `sudo linear-hub doctor` reports nothing to fix.
- [ ] **The locked-down service runs:** `systemctl is-active linear-hub caddy` says `active` twice, and
      `sudo systemd-analyze security linear-hub` rates it "OK" (1.5 in the installer's tests; write the score here:
      ______). The installer's tests ran the units under systemd in a container; this checks them on the real server.
- [ ] **Live, not trial:** `sudo linear-hub golive` said "Linear Hub is live" (or "already live"); there is no trial
      banner.
- [ ] **Two-step for the owner** set up, recovery codes stored away from the phone.
- [ ] **Recovery sheet** written, confirmed with `sudo linear-hub recovery-sheet --confirm` (Settings › Backups says
      "Printed and kept"), and locked away.
- [ ] **Off-site passphrase** on paper, kept apart from the recovery sheet.
- [ ] **Restore test passed** (`sudo linear-hub restore-test`) on: ____________
- [ ] **Monitoring:** the uptime check and the nightly-copy heartbeat (both required) email the owner and Noryn.
- [ ] **Payments** (if used): no test provider in the list; each connection went through test mode and a sandbox
      payment (or the 1p file) before live; the first live payment was one person and a small amount.
- [ ] **Bank details** were added by each person and confirmed by an administrator (nobody confirms their own change;
      details an administrator types wait for the person to confirm them).
- [ ] **The trial Mac** is stopped and its data folder deleted.

---

## 5. Everyday running: the `linear-hub` command

Run on the server with `sudo`. `sudo linear-hub help` lists everything.

| Command | What it does |
| --- | --- |
| `sudo linear-hub status` | Running? Does HTTPS answer? Newest backup and off-site copy, free disk |
| `sudo linear-hub logs` (`-f` to follow) | The service log |
| `sudo linear-hub restart` | Stop and start Linear Hub |
| `sudo linear-hub update` / `update v1.5.1` | Stop, back up and check the backup, update the code, start again. With a release tag it moves to that release. Either way it prints the way back (the previous release and the backup to restore) |
| `sudo linear-hub doctor` | A full check of the settings, the key, backups and off-site copies |
| `sudo linear-hub backup` / `backups` | A backup now / the list of backups |
| `sudo linear-hub offsite-sync` | Copy the encrypted backups off the server now |
| `sudo linear-hub restore-test` | Prove the newest off-site copy can be restored (every few months, and after big changes) |
| `sudo linear-hub restore <file>` | Put a backup back (stops Linear Hub meanwhile; lists any payments it would forget and asks for RESTORE). Use a name from `backups`, or an encrypted `.lhbk` anywhere (a file the `linear` user cannot read, say under `/root`, is copied in first) |
| `sudo linear-hub import <file.lhbk>` | Bring a database from another computer (asks its passphrase, or `--passphrase-file <file>`) |
| `sudo linear-hub golive` | End the trial (once) |
| `sudo linear-hub recovery-sheet` | Show the recovery sheet to copy onto paper; `--confirm` to type the key back from the paper |
| `sudo linear-hub key:restore` | Put the app key back from the recovery sheet |
| `sudo linear-hub setup-code <email>` | A new one-time setup code for someone who has not finished setting up |
| `sudo linear-hub 2fa:reset <email>` / `pin:reset <email>` | Reset someone's two-step or PIN; prints the setup code they sign in with next |

**Updates.** Noryn applies Linear Hub updates as part of the monthly service, with `sudo linear-hub update`; it backs
up and checks the database before changing anything, and prints the way back: `sudo linear-hub update <previous>`,
then `sudo linear-hub restore <the backup it just made>`. Ubuntu's security updates install
themselves every night (the server restarts itself at about 04:30 when one needs it, and Linear Hub and Caddy start
again by themselves). Node.js is updated by Noryn, after the tests pass on the new version:
`sudo apt-get install --only-upgrade nodejs && sudo linear-hub restart`.

---

## 6. When something goes wrong

**The site does not answer.** `sudo linear-hub status`; then `sudo linear-hub logs` (Linear Hub) or
`sudo journalctl -u caddy -n 50` (HTTPS). The uptime monitor will have emailed.

**Linear Hub will not start and says the app key is missing or does not fit.** Do not delete anything. Run
`sudo linear-hub key:restore` and type the key from the recovery sheet; it checks the key before saving it. The service
does not restart itself in a loop while the key is wrong.

**The only administrator is locked out** (lost phone, forgotten PIN): `sudo linear-hub 2fa:reset you@example.co.uk` or
`sudo linear-hub pin:reset you@example.co.uk`. It prints the setup code to sign in with next.

**A restore from an older backup.** `sudo linear-hub backups` lists them; `sudo linear-hub restore <file>` puts one
back. It lists payments, bank files, bank details changes and paid weeks it would forget, and asks for **RESTORE**.
Afterwards, check those payments with the bank.

**The server is lost or broken.** On a new server (step 1), before running the installer, put the off-site
passphrase from the paper in place, so the new server keeps using it:

```bash
sudo install -d -m 700 /etc/linear-hub/keys
sudo sh -c 'cat > /etc/linear-hub/keys/backup-passphrase'     # type the passphrase, Enter, then Ctrl-D
```

Run the installer (step 4) with the same off-site store. Then fetch the newest copy and bring it in:

```bash
sudo -u linear rclone --config /opt/linear-hub/.config/rclone/rclone.conf lsf offsite:linear-hub/backups
sudo -u linear rclone --config /opt/linear-hub/.config/rclone/rclone.conf copy offsite:linear-hub/backups/<newest>.lhbk /var/lib/linear-hub/import/
sudo linear-hub import /var/lib/linear-hub/import/<newest>.lhbk          # type the off-site passphrase
sudo -u linear rclone --config /opt/linear-hub/.config/rclone/rclone.conf copy offsite-media: /var/lib/linear-hub/media   # the videos
```

(For an S3 bucket the path is `offsite:<bucket>/linear-hub/backups`.) Point the DNS at the new server (step 2), check
the fingerprint in Settings › Backups against the recovery sheet, and run `sudo linear-hub restore-test`.

---

## 7. What the installer sets, and why

- **Linear Hub listens on `127.0.0.1` only** (`HOST=127.0.0.1`); Caddy is the only way in. `TRUST_PROXY=1` (exactly one
  proxy) lets Linear Hub see each phone's address and that the request came over HTTPS, so cookies are `Secure`, HSTS
  is sent, and money and secret actions (which refuse insecure requests) work. `COOKIE_SECURE=1` too.
- **No demo sign-ins on the internet:** `LM_DEMO_ACCOUNTS=0` always. The installer also removes `LM_PAYMENTS_FAKE` and
  `LM_BUSINESS_NOW` (demo settings) and `LM_TLS_CERT_FILE` / `LM_TLS_KEY_FILE` (Caddy does HTTPS) if they appear.
- **Keys outside the data folder:** `LM_APP_SECRET_FILE=/etc/linear-hub/keys/app-secret` and
  `LM_BACKUP_PASSPHRASE_FILE=/etc/linear-hub/keys/backup-passphrase`, readable by the `linear` user only. A new key is
  made only when there is no database yet; the installer never replaces a key or a passphrase.
- **Off-site copies:** `LM_OFFSITE_DIR=/var/lib/linear-hub/offsite`. Linear Hub encrypts each copy before it is
  written there (AES-256-GCM, from the passphrase); rclone only carries the files away, with `copy` (never `sync`), so
  nothing off-site is ever deleted by an empty folder here. A copy cut off half-way (a dropped connection, the 04:30
  restart) is shorter than the file on the server, so the next night sends it again. The learning videos are copied
  with rclone's own encryption under the same passphrase; a video still uploading (`*.upload`) waits for the next
  night.
- **The off-site store's settings:** rclone's own settings file for the `linear` user. The installer makes each remote
  afresh whenever an answer changes (a new Storage Box, user, bucket, region or folder), so a re-run really moves the
  copies; a Storage Box's host keys are recorded for rclone, which refuses a host it does not know. The nightly copy
  may write that settings file (rclone notes what it learns about the store there), and nothing else outside the data
  folder.
- **Caddy's check runs as Caddy:** the installer checks the Caddyfile as the `caddy` user, and gives the Caddy log
  back to `caddy` if anything else made it, so Caddy can always open its log and start.
- **A locked-down service** (`/etc/systemd/system/linear-hub.service`): runs as `linear` with no shell; may write only
  `/var/lib/linear-hub` and its key folder (only to make a key for a database with nothing locked yet, as on a first
  start; it never replaces a key); private `/tmp`; no access to home folders, devices, kernel settings or other
  processes; no extra privileges; restarts by itself after a crash, but not when the key is missing or wrong once
  something is locked with it (exit code 78). `systemd-analyze security` rates it 1.5 ("OK").
- **The nightly copy** (`linear-hub-offsite.service`, started by its timer) is locked down the same way: it may write
  only the data folder and rclone's own settings, and reach the network (rated 1.5).
- **Firewall:** `ufw` lets in SSH (rate-limited), 80 and 443 only.
- **Updates:** Ubuntu's and Caddy's security updates install every night; the server restarts itself at about 04:30
  when one needs it. Node.js is left to Noryn so a new version never arrives untested.
- **SSH:** password log-in is turned off only when you log in with a key and say yes.

Settings you may add to `/etc/linear-hub/linear-hub.env` (kept by the installer): `LM_BACKUP_VIDEOS=1` (videos inside
every backup too; large), `LM_BACKUP_HOUR` (the nightly backup's hour, default 2), `LM_SMART=0`, `LM_STATEMENTS_JOB=0`.
Restart afterwards: `sudo linear-hub restart`.

---

## 8. Other ways to host it (not the supported go-live)

- **Built-in HTTPS without Caddy.** Linear Hub can serve HTTPS itself with `LM_TLS_CERT_FILE` and `LM_TLS_KEY_FILE`
  (a certificate and its key) on `PORT`. Then you renew the certificate yourself; Caddy does that for you, so the
  installer uses Caddy.
- **Fly.io or Render** can run the repository's `Dockerfile` with a persistent disk. The installer, the off-site
  copies, the restore test and the `linear-hub` command assume a server, so this route is not supported for go-live.
- **Supabase or another database** is not needed to go online and is not the next step. It would only be worth it for
  several offices or hundreds of people at once, and would mean rewriting the data layer: see
  [`ROADMAP.md`](ROADMAP.md).

---

## Trial only: the office Mac

> **For the trial week only.** Do not put real pay, real bank details or real payments through the Mac. Go live on the
> server first.

During the trial Linear Hub runs on the office Mac, and phones reach it over the **same Wi-Fi or the Mac's hotspot**,
over plain `http://`:

- `npm start` (or `npm run service:install` to keep it running in the background), then `npm run share` prints the
  address and a QR code for the phones.
- **What does not work there:** phones away from that Wi-Fi or hotspot cannot reach it at all; a sleeping or closed
  Mac answers nobody; there is no home-screen app or opening without signal (they need HTTPS); bank details, payments,
  setup codes and two-step resets work only on the Mac itself, never from a phone over Wi-Fi (plain http is readable
  by others on the same network); and the backups sit on the Mac's own disk.
- **Never** forward the Mac's port to the internet or put it on a public address.
- The demo company and its one-tap sign-ins are there to try every screen; they can never touch real bank details or
  payments, and `npm run golive` (on the server, step 6) removes them.

---

## For developers: testing the installer

- `bash deploy/tests/run.sh` — no root, no network: shellcheck on every script, the installer's helpers, and a full
  `--dry-run` on a pretend fresh server (every file it would write, every command it would run). `npm test` runs it
  too on Linux, so CI checks the installer on every change.
- `bash deploy/tests/container-test.sh <repository folder> <branch>` — needs Docker: installs from scratch in a
  throwaway Ubuntu 24.04 container, runs it twice more to prove it changes nothing the second time, checks the files
  and modes, `caddy validate`, starts Linear Hub as the service does, makes an encrypted backup, copies it off-site,
  passes `linear-hub restore-test` (and checks its scratch copy is stopped), brings in a trial database made by a
  stand-in Mac with `linear-hub import`, goes live, then sets up a Storage Box over SFTP (an OpenSSH server on port 23
  in the container) with `--yes`, adds the key by hand as the owner would, moves to a second box, user and folder,
  copies and restore-tests there, updates to a release tag, restores a file kept under `/root`, gives a Caddy log made
  by root back to `caddy`, and starts again with only the data folder writable. With `LH_TEST_SYSTEMD=1` it then boots
  the installed machine with systemd (a privileged container with no network) and runs the real units: the
  locked-down service starts and answers, `systemd-analyze security` rates it, Caddy runs as `caddy`, the nightly copy
  runs under its own lock-down, `linear-hub restart` works, a missing key is made anew while nothing is locked, and
  once something is, a missing key stops the service with exit code 78 and no restart loop. The firewall is checked
  by the dry run only (a container must not change the test machine's firewall). S3 buckets are checked by the dry
  run (region, provider, no secret shown), not against a real bucket.
  Options: `LH_TEST_PREINSTALL=1` (Node and Caddy put in first, for networks that block their repositories),
  `LH_TEST_NODE_DIR=/opt/node22` (copy Node from the test machine instead of downloading it), `LH_TEST_SYSTEMD=1`,
  `LH_TEST_KEEP_IMAGE=1`, `LH_TEST_CA`, `LH_TEST_PORT`.
- `bash deploy/install.sh --dry-run --yes --domain … --email … --repo …` shows what a run would do on a real server.
