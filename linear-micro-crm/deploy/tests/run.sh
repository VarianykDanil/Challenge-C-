#!/usr/bin/env bash
# Tests for deploy/install.sh that need no root, no network and no server:
#   1. every shell script parses, and is clean under shellcheck when shellcheck is installed;
#   2. the installer's own helpers (checks on answers, the environment file merge, templates);
#   3. a full --dry-run on a pretend fresh server, checking every file it would write and every command it would run.
# Run from anywhere:  bash deploy/tests/run.sh
# LH_REQUIRE_SHELLCHECK=1 makes a missing shellcheck a failure (CI). The end-to-end run in a throwaway Ubuntu 24.04
# container is deploy/tests/container-test.sh.
# shellcheck source-path=SCRIPTDIR
set -Eeuo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY=$(cd "$HERE/.." && pwd)
INSTALL="$DEPLOY/install.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

passed=0
failed=0
pass() { passed=$((passed + 1)); printf '  ok   %s\n' "$1"; }
fail() { failed=$((failed + 1)); printf '  FAIL %s\n' "$1"; }
check() { # check "description" command...
  local what=$1
  shift
  if "$@" >/dev/null 2>&1; then pass "$what"; else fail "$what"; fi
}
has_line() { grep -qxF -- "$2" "$1"; }  # the file holds exactly this line
has_text() { grep -qF -- "$2" "$1"; }   # the file holds this text somewhere
lacks_text() { ! grep -qF -- "$2" "$1"; }
lacks_setting() { ! grep -qE -- "^$2" "$1"; } # no line sets this (comments may still name it)

echo "1. Scripts parse and pass shellcheck"
mapfile -t scripts < <(find "$DEPLOY" -type f -name '*.sh' | sort)
scripts+=("$DEPLOY/templates/linear-hub")
for s in "${scripts[@]}"; do
  check "bash -n ${s#"$DEPLOY"/}" bash -n "$s"
done
if command -v shellcheck >/dev/null 2>&1; then
  if out=$(shellcheck -x -S style "${scripts[@]}" 2>&1); then
    pass "shellcheck (style level) on ${#scripts[@]} scripts"
  else
    fail "shellcheck (style level) on ${#scripts[@]} scripts"
    printf '%s\n' "$out" | sed 's/^/       /'
  fi
elif [[ ${LH_REQUIRE_SHELLCHECK:-0} == 1 ]]; then
  fail "shellcheck is not installed (LH_REQUIRE_SHELLCHECK=1)"
else
  echo "  skip shellcheck is not installed (pip install shellcheck-py, or apt install shellcheck)"
fi

echo "2. The installer's helpers"
# shellcheck source=../install.sh
source "$INSTALL"
set +e # the installer turns errexit on; the checks below expect failures
trap 'rm -rf "$WORK"' EXIT

check "a normal domain is accepted" valid_domain hub.linear-mcr.co.uk
check "a domain with capitals is refused" bash -c "! (source '$INSTALL'; valid_domain Hub.Example.co.uk)"
check "a domain with a space is refused" bash -c "! (source '$INSTALL'; valid_domain 'hub example.co.uk')"
check "a bare word is refused" bash -c "! (source '$INSTALL'; valid_domain localhost)"
check "a domain with a slash is refused" bash -c "! (source '$INSTALL'; valid_domain 'hub.example.co.uk/x')"
check "an email is accepted" valid_email ops@example.co.uk
check "an email with a brace is refused" bash -c "! (source '$INSTALL'; valid_email 'a}b@example.co.uk')"
check "a git ref with a semicolon is refused" bash -c "! (source '$INSTALL'; valid_ref 'main;reboot')"
check "an https repository address is accepted" valid_repo https://github.com/example/linear-hub.git
check "a git@ repository address is accepted" valid_repo git@github.com:example/linear-hub.git
check "a repository address with a space is refused" bash -c "! (source '$INSTALL'; valid_repo 'https://x y')"
check "22.18.0 is new enough" node_version_ok v22.18.0
check "22.22.0 is new enough" node_version_ok v22.22.0
check "24.1.0 is new enough" node_version_ok v24.1.0
check "22.17.1 is too old" bash -c "! (source '$INSTALL'; node_version_ok v22.17.1)"
check "20.19.0 is too old" bash -c "! (source '$INSTALL'; node_version_ok v20.19.0)"
check "23.0.0 (not a long-term line) is refused" bash -c "! (source '$INSTALL'; node_version_ok v23.0.0)"
check "an S3 bucket name is accepted" valid_bucket linear-hub-backups
check "an S3 bucket name with a slash is refused" bash -c "! (source '$INSTALL'; valid_bucket 'a/b')"

# Templates: placeholders are filled, & and \ in values survive, and a placeholder left over is an error.
printf 'a=@ONE@ b=@TWO@\n' >"$WORK/t1"
check "render fills placeholders" test "$(render "$WORK/t1" ONE=x TWO='y&z\w')" = 'a=x b=y&z\w'
check "render refuses a placeholder left unfilled" bash -c "! (source '$INSTALL'; render '$WORK/t1' ONE=x)"

# The environment file merge: the installer's own lines win, the operator's extra lines stay, unsafe ones go.
cat >"$WORK/old.env" <<'EOF'
# written by hand
HOST=0.0.0.0
PORT=4000
LM_BACKUP_VIDEOS=1
LM_PAYMENTS_FAKE=1
LM_BUSINESS_NOW=2026-10-19T15:00:00
LM_TLS_CERT_FILE=/etc/ssl/a.pem
LM_TLS_KEY_FILE=/etc/ssl/a.key
EOF
env_merge "$WORK/old.env" >"$WORK/new.env" 2>"$WORK/merge.log"
check "merge: HOST is forced to 127.0.0.1" has_line "$WORK/new.env" HOST=127.0.0.1
check "merge: an extra setting of the owner's stays" has_line "$WORK/new.env" LM_BACKUP_VIDEOS=1
check "merge: LM_PAYMENTS_FAKE is removed" lacks_setting "$WORK/new.env" LM_PAYMENTS_FAKE=
check "merge: LM_BUSINESS_NOW is removed" lacks_setting "$WORK/new.env" LM_BUSINESS_NOW=
check "merge: built-in HTTPS is removed behind Caddy" lacks_setting "$WORK/new.env" LM_TLS_
check "merge: the owner is told what was removed" has_text "$WORK/merge.log" LM_PAYMENTS_FAKE
check "merge: HOST appears once" test "$(grep -c '^HOST=' "$WORK/new.env")" = 1
env_merge /dev/null >"$WORK/fresh.env" 2>/dev/null
check "merge: a fresh file has COOKIE_SECURE=1" has_line "$WORK/fresh.env" COOKIE_SECURE=1
printf 'LM_APP_SECRET=abc\n' >"$WORK/secret.env"
env_merge "$WORK/secret.env" >"$WORK/secret.out" 2>"$WORK/secret.log"
check "merge: LM_APP_SECRET is kept (removing it would change the key) but warned about" \
  bash -c "grep -qx 'LM_APP_SECRET=abc' '$WORK/secret.out' && grep -q LM_APP_SECRET '$WORK/secret.log'"

# A Storage Box address is checked before anything is written.
check "a Storage Box host is accepted" valid_host u123456.your-storagebox.de
check "a host with a port is refused" bash -c "! (source '$INSTALL'; valid_host 'u1.your-storagebox.de:23')"

# S3: the region is worked out from the usual endpoint addresses (AWS signs for us-east-1 without one and refuses).
check "S3 region: AWS London" test "$(s3_region_for https://s3.eu-west-2.amazonaws.com)" = eu-west-2
check "S3 region: AWS, old dash form" test "$(s3_region_for https://s3-eu-west-1.amazonaws.com)" = eu-west-1
check "S3 region: AWS dual-stack" test "$(s3_region_for https://s3.dualstack.eu-west-2.amazonaws.com)" = eu-west-2
check "S3 region: AWS without a region is us-east-1" test "$(s3_region_for https://s3.amazonaws.com)" = us-east-1
check "S3 region: Hetzner Object Storage" test "$(s3_region_for https://fsn1.your-objectstorage.com)" = fsn1
check "S3 region: Backblaze B2" test "$(s3_region_for https://s3.eu-central-003.backblazeb2.com)" = eu-central-003
check "S3 region: unknown provider gives none" test -z "$(s3_region_for https://minio.example.co.uk)"
check "S3 provider: AWS for amazonaws.com" test "$(s3_provider_for https://s3.eu-west-2.amazonaws.com)" = AWS
check "S3 provider: Other for anything else" test "$(s3_provider_for https://fsn1.your-objectstorage.com)" = Other

# An rclone remote is kept only when every setting already has the wanted value.
shown=$'[offsite]\ntype = sftp\nhost = a.example.co.uk\nuser = u1\nport = 23'
check "remote_matches: same settings" remote_matches "$shown" type=sftp host=a.example.co.uk user=u1 port=23
check "remote_matches: a setting left over from an earlier answer does not match" \
  bash -c "! (source '$INSTALL'; remote_matches \"\$1\" type=sftp host=a.example.co.uk port=23)" _ "$shown"
check "remote_matches: secrets are not compared" \
  remote_matches $'[s]\ntype = s3\nsecret_access_key = x\nregion = eu-west-2' type=s3 region=eu-west-2
check "remote_matches: a changed host does not match" bash -c "! (source '$INSTALL'; remote_matches \"\$1\" type=sftp host=b.example.co.uk)" _ "$shown"
check "remote_matches: a changed type does not match" bash -c "! (source '$INSTALL'; remote_matches \"\$1\" type=s3 host=a.example.co.uk)" _ "$shown"
check "remote_matches: no remote does not match" bash -c "! (source '$INSTALL'; remote_matches '' type=sftp)"

set -e

echo "3. A dry run on a pretend fresh server"
PREVIEW="$WORK/preview"
run_dry() {
  bash "$INSTALL" --dry-run --preview "$PREVIEW" --yes \
    --domain hub.example.co.uk --email ops@example.co.uk \
    --repo https://github.com/example/linear-hub.git --ref main \
    --offsite storagebox --storagebox-host u123456.your-storagebox.de --storagebox-user u123456 \
    --heartbeat-url 'https://hc-ping.com/0000-test?x=1&y=2'
}
if run_dry >"$WORK/dry.out" 2>&1; then pass "the dry run finishes"; else
  fail "the dry run finishes"
  sed 's/^/       /' "$WORK/dry.out" | tail -30
fi
CMDS="$PREVIEW/COMMANDS"
MODES="$PREVIEW/MODES"
ENVF="$PREVIEW/etc/linear-hub/linear-hub.env"
UNIT="$PREVIEW/etc/systemd/system/linear-hub.service"
CADDY="$PREVIEW/etc/caddy/Caddyfile"
TIMER="$PREVIEW/etc/systemd/system/linear-hub-offsite.timer"
SYNCUNIT="$PREVIEW/etc/systemd/system/linear-hub-offsite.service"
CLI="$PREVIEW/usr/local/bin/linear-hub"
OFFCONF="$PREVIEW/etc/linear-hub/offsite.conf"

check "nothing was changed outside the preview (no /etc/linear-hub here)" test ! -e /etc/linear-hub/install.conf -o -n "${LH_TEST_ON_SERVER:-}"
check "the environment file would be written" test -f "$ENVF"
check "the environment file is 0600 root:root" has_line "$MODES" "/etc/linear-hub/linear-hub.env 0600 root:root"
for line in HOST=127.0.0.1 PORT=4000 COOKIE_SECURE=1 TRUST_PROXY=1 LM_DEMO_ACCOUNTS=0 TZ=Europe/London \
  DB_PATH=/var/lib/linear-hub/linear.sqlite LM_BACKUP_DIR=/var/lib/linear-hub/backups \
  LM_APP_SECRET_FILE=/etc/linear-hub/keys/app-secret LM_UPLOADS_DIR=/var/lib/linear-hub/uploads \
  LM_STATEMENTS_DIR=/var/lib/linear-hub/statements LM_OFFSITE_DIR=/var/lib/linear-hub/offsite \
  LM_BACKUP_PASSPHRASE_FILE=/etc/linear-hub/keys/backup-passphrase; do
  check "env: $line" has_line "$ENVF" "$line"
done
check "env: the app key file is outside the data folder" \
  bash -c "! grep -q '^LM_APP_SECRET_FILE=/var/lib/linear-hub' '$ENVF'"
check "env: no LM_APP_SECRET, LM_PAYMENTS_FAKE or LM_BUSINESS_NOW" \
  bash -c "! grep -Eq '^(LM_APP_SECRET|LM_PAYMENTS_FAKE|LM_BUSINESS_NOW)=' '$ENVF'"
check "env: NODE_ENV is not in the file (npm would skip the build tools)" lacks_setting "$ENVF" NODE_ENV=
check "the key folder is 0700 linear:linear" has_line "$MODES" "/etc/linear-hub/keys 0700 linear:linear"
check "the data folder is 0700 linear:linear" has_line "$MODES" "/var/lib/linear-hub 0700 linear:linear"
check "the off-site folder is made (Linear Hub never makes it)" has_line "$MODES" "/var/lib/linear-hub/offsite 0700 linear:linear"
check "the app key would be made 0600 linear" has_line "$MODES" "/etc/linear-hub/keys/app-secret 0600 linear:linear"
check "the passphrase would be made 0600 linear" has_line "$MODES" "/etc/linear-hub/keys/backup-passphrase 0600 linear:linear"
check "no key or passphrase is written into the preview" \
  bash -c "test ! -s '$PREVIEW/etc/linear-hub/keys/app-secret' && test ! -s '$PREVIEW/etc/linear-hub/keys/backup-passphrase'"

check "unit: runs as linear" has_line "$UNIT" "User=linear"
check "unit: reads the environment file" has_line "$UNIT" "EnvironmentFile=/etc/linear-hub/linear-hub.env"
check "unit: NODE_ENV=production" has_line "$UNIT" "Environment=NODE_ENV=production"
check "unit: may write only the data folder" \
  bash -c "grep -qx 'ProtectSystem=strict' '$UNIT' && grep -qx 'ReadWritePaths=/var/lib/linear-hub' '$UNIT'"
for line in NoNewPrivileges=yes ProtectHome=yes PrivateTmp=yes PrivateDevices=yes CapabilityBoundingSet= \
  RestrictSUIDSGID=yes SystemCallFilter=@system-service RestartPreventExitStatus=78 UMask=0077; do
  check "unit: $line" has_line "$UNIT" "$line"
done
check "unit: starts the server from the checkout" has_text "$UNIT" "WorkingDirectory=/opt/linear-hub/app/linear-micro-crm/server"
check "unit: no placeholder left" bash -c "! grep -Eq '@[A-Z_]+@' '$UNIT'"

check "Caddy: a site for the domain" has_line "$CADDY" "hub.example.co.uk {"
check "Caddy: passes requests to 127.0.0.1:4000" has_text "$CADDY" "reverse_proxy 127.0.0.1:4000"
check "Caddy: the certificate email" has_text "$CADDY" "email ops@example.co.uk"
check "Caddy: no placeholder left" bash -c "! grep -Eq '@[A-Z_]+@' '$CADDY'"

check "off-site: nightly in London time and caught up after downtime" \
  bash -c "grep -q '^OnCalendar=.*Europe/London' '$TIMER' && grep -qx 'Persistent=true' '$TIMER'"
check "off-site: the copy runs as linear" has_line "$SYNCUNIT" "User=linear"
check "off-site: the settings name the Storage Box remote" has_line "$OFFCONF" "OFFSITE_TARGET=offsite:linear-hub"
check "off-site: the heartbeat URL survives & in it" has_line "$OFFCONF" "HEARTBEAT_URL=https://hc-ping.com/0000-test?x=1&y=2"
check "off-site: settings are 0640 root:linear" has_line "$MODES" "/etc/linear-hub/offsite.conf 0640 root:linear"
check "off-site: the Storage Box remote is made with an SSH key on port 23" \
  bash -c "grep -q 'rclone .*config create offsite sftp' '$CMDS' && grep -q 'port=23' '$CMDS' && grep -q 'key_file=/opt/linear-hub/.ssh/offsite_ed25519' '$CMDS'"
# `rclone config update NAME TYPE key=value` reads TYPE as a setting and swallows the next one, and cannot change a
# remote's type: a changed answer must make the remote afresh.
check "off-site: no remote is ever changed with rclone config update" lacks_text "$CMDS" "config update"
# rclone refuses a Storage Box whose host keys are not in known_hosts, and with only one key type recorded it can still
# fail ("key mismatch"), so every key type the box offers is recorded, and the fingerprints are shown to compare.
check "off-site: the Storage Box host keys (every type) are recorded for rclone" \
  grep -Eq '^runuser -u linear -- .*ssh-keyscan -p 23 u123456\.your-storagebox\.de( |$)' "$CMDS"
check "off-site: …not only one key type" bash -c "! grep -E 'ssh-keyscan .*-t ' '$CMDS'"
check "off-site: the store is proven by writing to it, not by mkdir alone (mkdir does nothing on S3)" \
  has_text "$CMDS" "rcat offsite:linear-hub/.linear-hub-check"
check "Caddy's file is checked as the caddy user (a log file made by root would stop Caddy starting)" \
  grep -Eq '^runuser -u caddy -- .*caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile' "$CMDS"
SYNC="$PREVIEW/usr/local/lib/linear-hub/offsite-sync.sh"
check "off-site copy: no --immutable (a copy cut off half-way must be sent again, not refused for ever)" lacks_text "$SYNC" "--immutable"
check "off-site copy: compares by size, so a short copy is sent again" has_text "$SYNC" "--size-only"
check "off-site copy: half-uploaded videos are skipped" has_text "$SYNC" "--exclude '*.upload'"

check "updates: security updates every day" has_text "$PREVIEW/etc/apt/apt.conf.d/20auto-upgrades" 'APT::Periodic::Unattended-Upgrade "1";'
check "updates: restart at night when an update needs it" has_text "$PREVIEW/etc/apt/apt.conf.d/52linear-hub-unattended-upgrades" 'Automatic-Reboot "true"'

check "firewall: deny incoming by default" has_text "$CMDS" "ufw default deny incoming"
check "firewall: SSH" grep -Eq '^ufw limit 22/tcp' "$CMDS"
check "firewall: 80" grep -Eq '^ufw allow 80/tcp' "$CMDS"
check "firewall: 443" grep -Eq '^ufw allow 443/tcp' "$CMDS"
check "firewall: switched on" grep -Eq '^ufw --force enable' "$CMDS"
check "firewall: no other port is opened" \
  bash -c "! grep -E '^ufw (allow|limit) ' '$CMDS' | grep -Ev '^ufw (allow|limit) (22/tcp|80/tcp|443/tcp|443/udp)( |$)'"
check "Node 22 from NodeSource" has_text "$PREVIEW/etc/apt/sources.list.d/nodesource.list" "https://deb.nodesource.com/node_22.x nodistro main"
check "Caddy from its own signed repository" has_text "$PREVIEW/etc/apt/sources.list.d/caddy-stable.list" "signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
check "the service user is made without a shell" bash -c "grep -q '^useradd .*--system' '$CMDS' && grep -q 'nologin' '$CMDS'"
check "the code is cloned as linear on the chosen branch" grep -Eq '^runuser -u linear -- .*git clone --branch main https://github.com/example/linear-hub.git /opt/linear-hub/app' "$CMDS"
check "the service is switched on" has_text "$CMDS" "systemctl enable linear-hub.service"
check "the off-site timer is switched on" has_text "$CMDS" "systemctl enable --now linear-hub-offsite.timer"
check "Caddy's file is checked before it is used" has_text "$CMDS" "caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile"
check "the linear-hub command is installed" test -f "$CLI"
check "the linear-hub command parses" bash -n "$CLI"
check "the linear-hub command has no placeholder left" bash -c "! grep -Eq '@[A-Z_]+@' '$CLI'"
check "the dry run says it changed nothing" has_text "$WORK/dry.out" "Dry run: nothing was changed"
check "the summary gives the health check address" has_text "$WORK/dry.out" "https://hub.example.co.uk/api/health"

echo "4. Wrong answers stop before anything happens"
expect_refusal() { # expect_refusal "description" "message part" args...
  local what=$1 msg=$2
  shift 2
  local out
  if out=$(bash "$INSTALL" --dry-run --preview "$WORK/p2" --yes "$@" 2>&1); then
    fail "$what (it did not stop)"
  elif grep -qF -- "$msg" <<<"$out"; then pass "$what"; else
    fail "$what (message was: $(tail -1 <<<"$out"))"
  fi
}
base=(--email ops@example.co.uk --repo https://github.com/example/linear-hub.git --ref main --offsite none)
expect_refusal "no domain with --yes" "domain" "${base[@]}"
expect_refusal "a bad domain" "not a domain name" --domain 'bad domain' "${base[@]}"
expect_refusal "an unknown option" "Unknown option" --domain hub.example.co.uk --colour "${base[@]}"
expect_refusal "S3 without a bucket" "bucket" --domain hub.example.co.uk --email ops@example.co.uk \
  --repo https://github.com/example/linear-hub.git --ref main --offsite s3 --s3-endpoint https://s3.example.com
expect_refusal "an unknown off-site choice" "storagebox, s3, existing or none" --domain hub.example.co.uk \
  --email ops@example.co.uk --repo https://github.com/example/linear-hub.git --ref main --offsite dropbox

echo "5. Off-site choices"
if bash "$INSTALL" --dry-run --preview "$WORK/p3" --yes --domain hub.example.co.uk --email ops@example.co.uk \
  --repo https://github.com/example/linear-hub.git --ref main --offsite none >"$WORK/none.out" 2>&1; then
  pass "no off-site store is allowed"
else
  fail "no off-site store is allowed"
fi
check "…but the summary warns that backups stay on the server" has_text "$WORK/none.out" "stay on this server"
check "…and no timer is switched on" bash -c "! grep -q 'enable --now linear-hub-offsite.timer' '$WORK/p3/COMMANDS'"
if S3_SECRET_ACCESS_KEY=test-secret bash "$INSTALL" --dry-run --preview "$WORK/p4" --yes --domain hub.example.co.uk \
  --email ops@example.co.uk --repo git@github.com:example/linear-hub.git --ref v1.5.0 --offsite s3 \
  --s3-endpoint https://s3.eu-central-1.example.com --s3-bucket linear-hub-backups --s3-access-key-id AKIDTEST \
  --s3-region eu-central-1 >"$WORK/s3.out" 2>&1; then
  pass "an S3-compatible bucket"
else
  fail "an S3-compatible bucket"
  tail -5 "$WORK/s3.out" | sed 's/^/       /'
fi
check "…the remote points at the bucket" has_line "$WORK/p4/etc/linear-hub/offsite.conf" "OFFSITE_TARGET=offsite:linear-hub-backups/linear-hub"
check "…the secret key never appears in the commands shown" bash -c "! grep -rq test-secret '$WORK/p4' '$WORK/s3.out'"
check "…an SSH repository gets a deploy key" has_text "$WORK/p4/COMMANDS" "deploy_ed25519"
check "…the given region is used" grep -Eq 'config create offsite s3 .*region=eu-central-1' "$WORK/p4/COMMANDS"
if S3_SECRET_ACCESS_KEY=test-secret bash "$INSTALL" --dry-run --preview "$WORK/p5" --yes --domain hub.example.co.uk \
  --email ops@example.co.uk --repo https://github.com/example/linear-hub.git --ref main --offsite s3 \
  --s3-endpoint https://s3.eu-west-2.amazonaws.com --s3-bucket linear-hub-backups --s3-access-key-id AKIDTEST \
  >"$WORK/aws.out" 2>&1; then
  pass "AWS S3 London without --s3-region"
else
  fail "AWS S3 London without --s3-region"
  tail -5 "$WORK/aws.out" | sed 's/^/       /'
fi
check "…the region is worked out from the endpoint" grep -Eq 'config create offsite s3 .*region=eu-west-2' "$WORK/p5/COMMANDS"
check "…as an AWS bucket" grep -Eq 'config create offsite s3 provider=AWS ' "$WORK/p5/COMMANDS"
check "…the region is not saved as an answer (a new endpoint works it out again)" has_line "$WORK/p5/etc/linear-hub/install.conf" "S3_REGION="

echo "6. SSH keys only"
if bash "$INSTALL" --dry-run --preview "$WORK/p6" --yes --domain hub.example.co.uk --email ops@example.co.uk \
  --repo https://github.com/example/linear-hub.git --ref main --offsite none --ssh-keys-only yes >"$WORK/ssh.out" 2>&1; then
  pass "keys-only SSH"
else
  fail "keys-only SSH"
fi
check "…the setting is written" test -f "$WORK/p6/etc/ssh/sshd_config.d/10-linear-hub.conf"
# Ubuntu 24.04 starts SSH on demand (ssh.socket): from a provider's console ssh.service may not be running, and a
# plain reload would then stop the installer.
check "…SSH picks it up without failing when ssh.service is not running" has_line "$WORK/p6/COMMANDS" "systemctl try-reload-or-restart ssh"

echo
echo "$passed passed, $failed failed"
[[ $failed == 0 ]]
