#!/usr/bin/env bash
# End-to-end test of deploy/install.sh in a throwaway Ubuntu 24.04 container. Needs docker and network access; it
# changes nothing on the machine running it except the container, which it removes at the end.
#
#   bash deploy/tests/container-test.sh <git repository folder> <branch>
#
# What it does, as root inside the container (no systemd there, so the installer runs with --allow-no-systemd: it
# writes the services but cannot start them, and leaves the firewall alone; tests/run.sh covers those commands):
#   1. runs the installer from scratch with no off-site store, then adds an rclone remote called "offsite" (a local
#      folder standing in for the Storage Box) and runs the installer again with --offsite existing, checking that the
#      second run keeps the app key and the passphrase;
#   2. checks the settings file, folders and modes, and that Caddy accepts the Caddyfile (caddy validate);
#   3. starts Linear Hub the way the service does (as linear, with the settings file) and checks it answers on
#      127.0.0.1 only;
#   4. linear-hub backup (an encrypted .lhbk lands in the off-site folder), linear-hub offsite-sync (it reaches the
#      "off-site" folder), linear-hub restore-test (downloads it, decrypts it, starts it, checks it), linear-hub golive;
#   5. starts the server again on a read-only system with only the data folder writable, as ProtectSystem=strict does.
#
# Settings for the test machine only (none of them change the installer):
#   LH_TEST_IMAGE        image to start from (default ubuntu:24.04)
#   LH_TEST_PORT         port Linear Hub uses inside the container (default 4000; the container shares the host's
#                        network, so pick a free one); the restore test uses LH_TEST_PORT2 (default LH_TEST_PORT+100)
#   LH_TEST_PREINSTALL=1 put Node 22 (from nodejs.org, checksum checked) and Caddy (Ubuntu's package) in first, for
#                        networks that block deb.nodesource.com and dl.cloudsmith.io; the installer then finds them
#   HTTPS_PROXY / LH_TEST_CA  a proxy and its CA certificate, passed into the container (apt is switched to https)
set -Eeuo pipefail

REPO=${1:?usage: container-test.sh <git repository folder> <branch>}
REF=${2:?usage: container-test.sh <git repository folder> <branch>}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd "$HERE/.." && pwd)
IMAGE=${LH_TEST_IMAGE:-ubuntu:24.04}
PORT=${LH_TEST_PORT:-4000}
PORT2=${LH_TEST_PORT2:-$((PORT + 100))}
NAME=lh-install-test-$$
WORK=$(mktemp -d)

cleanup() {
  docker rm -f "$NAME" "$NAME-ro" >/dev/null 2>&1 || true
  docker volume rm "$NAME-data" >/dev/null 2>&1 || true
  docker rmi "$NAME-img" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

git clone -q --bare "$REPO" "$WORK/repo.git"
mounts=(-v "$WORK/repo.git:/src/repo.git:ro" -v "$DEPLOY:/src/deploy:ro")
envs=()
if [[ -n ${HTTPS_PROXY:-} ]]; then envs+=(-e "HTTPS_PROXY=$HTTPS_PROXY" -e "https_proxy=$HTTPS_PROXY" -e "NO_PROXY=${NO_PROXY:-}"); fi
if [[ -n ${LH_TEST_CA:-} ]]; then mounts+=(-v "$LH_TEST_CA:/src/test-ca.crt:ro"); fi
envs+=(-e "LH_TEST_PREINSTALL=${LH_TEST_PREINSTALL:-0}" -e "LH_TEST_PORT=$PORT" -e "LH_RESTORE_TEST_PORT=$PORT2" -e "REF=$REF")

echo "Starting a throwaway $IMAGE container…"
docker run -d --name "$NAME" --network host "${envs[@]}" "${mounts[@]}" "$IMAGE" sleep infinity >/dev/null

docker exec -i "$NAME" bash -s <<'INSIDE'
set -Eeuo pipefail
pass=0
fail=0
ok() { pass=$((pass + 1)); printf '  ok   %s\n' "$1"; }
bad() { fail=$((fail + 1)); printf '  FAIL %s\n' "$1"; }
check() { local what=$1; shift; if "$@" >/dev/null 2>&1; then ok "$what"; else bad "$what"; fi; }

echo "== Preparing the test machine (not part of the installer)"
export DEBIAN_FRONTEND=noninteractive
if [[ -f /src/test-ca.crt ]]; then
  printf 'Acquire::https::CaInfo "/src/test-ca.crt";\n' >/etc/apt/apt.conf.d/99test-ca
fi
if [[ -n ${HTTPS_PROXY:-} ]]; then
  sed -i 's|http://|https://|g' /etc/apt/sources.list.d/ubuntu.sources
  printf 'Acquire::https::Proxy "%s";\n' "$HTTPS_PROXY" >/etc/apt/apt.conf.d/99test-proxy
fi
apt-get update -qq >/dev/null
apt-get install -y -qq ca-certificates curl xz-utils procps iproute2 >/dev/null
if [[ -f /src/test-ca.crt ]]; then
  cp /src/test-ca.crt /usr/local/share/ca-certificates/test-ca.crt && update-ca-certificates >/dev/null 2>&1 || true
fi
git config --system safe.directory '*' 2>/dev/null || { apt-get install -y -qq git >/dev/null; git config --system safe.directory '*'; }
if [[ $LH_TEST_PREINSTALL == 1 ]]; then
  v=v22.22.0
  curl -fsSLO "https://nodejs.org/dist/$v/node-$v-linux-x64.tar.xz"
  curl -fsSL "https://nodejs.org/dist/$v/SHASUMS256.txt" | grep " node-$v-linux-x64.tar.xz\$" | sha256sum -c - >/dev/null
  tar -xJf "node-$v-linux-x64.tar.xz" -C /usr/local --strip-components=1 && rm "node-$v-linux-x64.tar.xz"
  apt-get install -y -qq caddy >/dev/null 2>&1 || apt-get install -y -qq caddy
  echo "  Node $(node -v) and Caddy $(caddy version | cut -d' ' -f1) put in first (this network blocks their own repositories)"
fi
# A network that re-signs TLS: npm (run by the installer with a clean environment) trusts the test CA through its
# global settings file, which needs no change to the installer.
if [[ -f /src/test-ca.crt ]]; then
  npm_prefix=$(dirname "$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)")")
  mkdir -p "$npm_prefix/etc" && printf 'cafile=/src/test-ca.crt\n' >"$npm_prefix/etc/npmrc"
fi

common=(--yes --allow-no-systemd --domain hub.example.test --email ops@example.test --repo file:///src/repo.git
  --ref "$REF" --port "$LH_TEST_PORT")

echo "== 1. First run (no off-site store yet)"
if bash /src/deploy/install.sh "${common[@]}" --offsite none >/tmp/run1.log 2>&1; then ok "the installer finishes"; else
  bad "the installer finishes"; tail -40 /tmp/run1.log; exit 1
fi
check "it warns that the backups stay on the server" grep -q "stay on this server" /tmp/run1.log
key1=$(sha256sum /etc/linear-hub/keys/app-secret | cut -c1-16)
pass1=$(sha256sum /etc/linear-hub/keys/backup-passphrase | cut -c1-16)

echo "== 2. An rclone remote called offsite (a folder standing in for the Storage Box), second run"
install -d -o linear -g linear -m 700 /srv/offsite-store
runuser -u linear -- rclone --config /opt/linear-hub/.config/rclone/rclone.conf config create offsite alias \
  remote=/srv/offsite-store --non-interactive >/dev/null
if bash /src/deploy/install.sh "${common[@]}" --offsite existing >/tmp/run2.log 2>&1; then ok "the second run finishes"; else
  bad "the second run finishes"; tail -40 /tmp/run2.log; exit 1
fi
check "second run: the app key is kept" test "$(sha256sum /etc/linear-hub/keys/app-secret | cut -c1-16)" = "$key1"
check "second run: the passphrase is kept" test "$(sha256sum /etc/linear-hub/keys/backup-passphrase | cut -c1-16)" = "$pass1"
check "second run: says it kept them" bash -c "grep -q 'app key: kept' /tmp/run2.log && grep -q 'backup passphrase: kept' /tmp/run2.log"
check "second run: the code is not cloned again" grep -q "already cloned" /tmp/run2.log
check "second run: connected to the off-site store" grep -q "connected to offsite:linear-hub" /tmp/run2.log
check "the answers were kept for the next run" grep -qx "DOMAIN=hub.example.test" /etc/linear-hub/install.conf
if bash /src/deploy/install.sh "${common[@]}" --offsite existing >/tmp/run3.log 2>&1 && ! grep -q '· wrote ' /tmp/run3.log; then
  ok "a third run with the same answers changes no file"
else
  bad "a third run with the same answers changes no file"; grep '· wrote ' /tmp/run3.log || true
fi

echo "== 3. Files, folders and modes"
mode() { stat -c '%a %U:%G' "$1"; }
check "settings file 600 root:root" test "$(mode /etc/linear-hub/linear-hub.env)" = "600 root:root"
check "key folder 700 linear:linear" test "$(mode /etc/linear-hub/keys)" = "700 linear:linear"
check "app key 600 linear:linear, 64 hex characters" bash -c "[[ \$(stat -c '%a %U' /etc/linear-hub/keys/app-secret) == '600 linear' ]] && grep -Eqx '[0-9a-f]{64}' /etc/linear-hub/keys/app-secret"
check "passphrase 600 linear:linear, six groups of five" bash -c "[[ \$(stat -c '%a %U' /etc/linear-hub/keys/backup-passphrase) == '600 linear' ]] && grep -Eqx '([A-Z2-9]{5}-){5}[A-Z2-9]{5}' /etc/linear-hub/keys/backup-passphrase"
check "data folder 700 linear:linear" test "$(mode /var/lib/linear-hub)" = "700 linear:linear"
check "off-site settings 640 root:linear" test "$(mode /etc/linear-hub/offsite.conf)" = "640 root:linear"
for line in HOST=127.0.0.1 COOKIE_SECURE=1 TRUST_PROXY=1 LM_DEMO_ACCOUNTS=0 DB_PATH=/var/lib/linear-hub/linear.sqlite \
  LM_APP_SECRET_FILE=/etc/linear-hub/keys/app-secret LM_OFFSITE_DIR=/var/lib/linear-hub/offsite \
  LM_BACKUP_PASSPHRASE_FILE=/etc/linear-hub/keys/backup-passphrase "PORT=$LH_TEST_PORT"; do
  check "settings: $line" grep -qx "$line" /etc/linear-hub/linear-hub.env
done
check "the service user has no shell" test "$(getent passwd linear | cut -d: -f7)" = /usr/sbin/nologin
check "Caddy accepts the Caddyfile" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
check "the Caddyfile serves hub.example.test" grep -qx "hub.example.test {" /etc/caddy/Caddyfile
check "the screens were built" test -f /opt/linear-hub/app/linear-micro-crm/client/dist/index.html
check "the service file is in place" grep -qx "User=linear" /etc/systemd/system/linear-hub.service

echo "== 4. Linear Hub runs as the service runs it"
APP=/opt/linear-hub/app/linear-micro-crm
settings=()
while IFS= read -r l; do settings+=("$l"); done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' /etc/linear-hub/linear-hub.env)
start_server() {
  (cd "$APP/server" && runuser -u linear -- env -i HOME=/opt/linear-hub PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" \
    "${settings[@]}" NODE_ENV=production "$(command -v node)" src/index.ts >/tmp/server.log 2>&1 &)
  for _ in $(seq 1 45); do curl -fsS "http://127.0.0.1:$LH_TEST_PORT/api/health" 2>/dev/null | grep -q '"ok":true' && return 0; sleep 2; done
  tail -30 /tmp/server.log
  return 1
}
# '[n]ode' so the pattern never matches the shell that runs pkill.
stop_server() { pkill -f '[n]ode src/index.ts' || true; for _ in $(seq 1 20); do pgrep -f '[n]ode src/index.ts' >/dev/null || return 0; sleep 0.5; done; }
check "it starts and answers /api/health" start_server
check "it listens on 127.0.0.1 only" bash -c "ss -ltn | grep -q '127.0.0.1:$LH_TEST_PORT ' && ! ss -ltn | grep -Eq '(0.0.0.0|\*|\[::\]):$LH_TEST_PORT '"
check "it read the app key from outside the data folder (no key file in the data folder)" test ! -e /var/lib/linear-hub/app-secret
stop_server

echo "== 5. Backups, the off-site copy, the restore test and going live"
if linear-hub backup >/tmp/backup.log 2>&1; then ok "linear-hub backup"; else bad "linear-hub backup"; tail -20 /tmp/backup.log; fi
check "an encrypted copy is in the off-site folder" bash -c "ls /var/lib/linear-hub/offsite/linear-*.lhbk"
check "the encrypted copy holds no readable database" bash -c "! grep -qa 'SQLite format 3' /var/lib/linear-hub/offsite/linear-*.lhbk"
if linear-hub offsite-sync >/tmp/sync.log 2>&1; then ok "linear-hub offsite-sync"; else bad "linear-hub offsite-sync"; tail -20 /tmp/sync.log; fi
check "the copy reached the off-site store" bash -c "ls /srv/offsite-store/linear-hub/backups/linear-*.lhbk"
check "a second sync copies nothing again and still succeeds" linear-hub offsite-sync
check "the status line says ok" grep -q '^ok ' /var/lib/linear-hub/offsite-sync.status
if linear-hub restore-test >/tmp/restoretest.log 2>&1; then ok "linear-hub restore-test passes"; else bad "linear-hub restore-test passes"; tail -30 /tmp/restoretest.log; fi
check "…it names the copy it tested" grep -q "Restore test passed: linear-" /tmp/restoretest.log
check "…and leaves no decrypted copy behind" bash -c "! ls -d /var/lib/linear-hub/restore-test.* 2>/dev/null"
check "…and stops its scratch copy (nothing answers on the test port)" bash -c "! curl -fsS -m 3 http://127.0.0.1:$LH_RESTORE_TEST_PORT/api/health"

echo "== 5b. Bringing the trial database from the office Mac (DEPLOY.md step 5)"
# A stand-in for the Mac: its own demo database, key and folders, made by Linear Hub itself, then one encrypted copy
# locked with a one-off move passphrase, exactly as the Mac's commands in DEPLOY.md make it.
MAC=/tmp/mac
install -d -o linear -g linear -m 700 "$MAC" "$MAC/move"
mac_env=(DB_PATH="$MAC/linear.sqlite" LM_APP_SECRET_FILE="$MAC/app-secret" LM_UPLOADS_DIR="$MAC/uploads"
  LM_STATEMENTS_DIR="$MAC/statements" LM_BACKUP_DIR="$MAC/backups" PORT="$LH_RESTORE_TEST_PORT" HOST=127.0.0.1
  LM_BACKUP=0 LM_PAYMENTS_JOB=0 LM_STATEMENTS_JOB=0 TZ=Europe/London NODE_NO_WARNINGS=1)
as_mac() { (cd "$APP" && runuser -u linear -- env -i HOME=/opt/linear-hub PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" "${mac_env[@]}" "$@"); }
as_mac node server/src/index.ts >/tmp/mac-server.log 2>&1 &
mac_ok=0
for _ in $(seq 1 45); do curl -fsS "http://127.0.0.1:$LH_RESTORE_TEST_PORT/api/health" 2>/dev/null | grep -q '"ok":true' && { mac_ok=1; break; }; sleep 2; done
pkill -f "[n]ode server/src/index.ts" || true
sleep 2
check "the stand-in Mac made its own demo database" test "$mac_ok" = 1 -a -s "$MAC/linear.sqlite"
as_mac npm run --silent backup -- --new-passphrase "$MAC/move-pass" >/tmp/mac-pass.log 2>&1 || true
check "npm run backup -- --new-passphrase made the move passphrase (mode 600)" test "$(stat -c '%a' "$MAC/move-pass" 2>/dev/null)" = 600
as_mac LM_OFFSITE_DIR="$MAC/move" LM_BACKUP_PASSPHRASE_FILE="$MAC/move-pass" npm run --silent backup >/tmp/mac-backup.log 2>&1 || true
move_file=$(find "$MAC/move" -maxdepth 1 -name 'linear-*.lhbk' | head -n1)
if [[ -n $move_file ]]; then ok "the Mac's backup wrote one encrypted copy for the move"; else
  bad "the Mac's backup wrote one encrypted copy for the move"; tail -20 /tmp/mac-backup.log; exit 1
fi
server_key_before=$(sha256sum /etc/linear-hub/keys/app-secret | cut -c1-16)
cp "$move_file" /root/
if linear-hub import "/root/$(basename "$move_file")" --passphrase-file "$MAC/move-pass" --yes --forget-payments >/tmp/import.log 2>&1; then
  ok "linear-hub import"
else bad "linear-hub import"; tail -30 /tmp/import.log; fi
check "…the server now uses the trial's app key" cmp -s "$MAC/app-secret" /etc/linear-hub/keys/app-secret
check "…the server's own earlier key was kept aside, not deleted" bash -c "for f in /etc/linear-hub/keys/app-secret.*; do [[ \$(sha256sum \"\$f\" | cut -c1-16) == $server_key_before ]] && exit 0; done; exit 1"
check "…the import folder is empty again (no copy or passphrase left)" bash -c "[[ -z \$(ls -A /var/lib/linear-hub/import) ]]"
check "…the passphrase never appears in the output" bash -c "! grep -qF \"\$(cat $MAC/move-pass)\" /tmp/import.log"
check "…Linear Hub starts on the imported database with its key" start_server
stop_server
if linear-hub golive --confirm "GO LIVE" --owner-email owner@example.test --owner-first-name Test --owner-last-name Owner >/tmp/golive.log 2>&1; then
  ok "linear-hub golive"
else bad "linear-hub golive"; tail -30 /tmp/golive.log; fi
check "…it printed the first owner's setup code" grep -Eq '[A-HJ-KMNP-Z2-9]{4}-[A-HJ-KMNP-Z2-9]{4}-[A-HJ-KMNP-Z2-9]{4}' /tmp/golive.log
check "linear-hub status runs" linear-hub status
check "linear-hub help runs" linear-hub help

echo "${pass} ${fail}" >/tmp/result
INSIDE

read -r pass fail < <(docker exec "$NAME" cat /tmp/result)

echo "== 6. Read-only system: only the data folder can be written (as ProtectSystem=strict + ReadWritePaths)"
docker exec "$NAME" bash -c "pkill -f '[n]ode src/index.ts' || true"
docker commit "$NAME" "$NAME-img" >/dev/null
docker volume create "$NAME-data" >/dev/null
docker run -d --name "$NAME-ro" --network host --read-only --tmpfs /tmp --tmpfs /run \
  -v "$NAME-data:/var/lib/linear-hub" "$NAME-img" sleep infinity >/dev/null
docker exec -i "$NAME-ro" bash -s <<'READONLY' && pass=$((pass + 1)) || fail=$((fail + 1))
set -Eeuo pipefail
APP=/opt/linear-hub/app/linear-micro-crm
settings=()
while IFS= read -r l; do settings+=("$l"); done < <(grep -E '^[A-Za-z_][A-Za-z0-9_]*=' /etc/linear-hub/linear-hub.env)
(cd "$APP/server" && runuser -u linear -- env -i HOME=/opt/linear-hub PATH="$(dirname "$(command -v node)"):/usr/bin:/bin" \
  "${settings[@]}" NODE_ENV=production "$(command -v node)" src/index.ts >/tmp/server.log 2>&1 &)
for _ in $(seq 1 45); do
  if curl -fsS "http://127.0.0.1:$(grep -E '^PORT=' /etc/linear-hub/linear-hub.env | cut -d= -f2)/api/health" 2>/dev/null | grep -q '"ok":true'; then
    if grep -qiE 'EROFS|read-only file system' /tmp/server.log; then echo "  FAIL it wrote outside the data folder:"; grep -iE 'EROFS|read-only' /tmp/server.log; exit 1; fi
    echo "  ok   it starts and answers with only /var/lib/linear-hub writable"
    exit 0
  fi
  sleep 2
done
echo "  FAIL it did not start read-only:"; tail -30 /tmp/server.log; exit 1
READONLY

echo
echo "$pass passed, $fail failed"
[[ $fail == 0 ]]
