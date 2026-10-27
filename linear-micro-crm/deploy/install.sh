#!/usr/bin/env bash
# Linear Hub installer for a fresh Ubuntu 24.04 LTS server (docs/DEPLOY.md, route A).
#
# What it sets up: a service user, Node.js 22 LTS, the code, the settings file, a locked-down systemd service, Caddy
# with automatic HTTPS for your domain, a firewall that lets in SSH, 80 and 443 only, automatic security updates, an
# off-site copy of the encrypted backups through rclone (a Hetzner Storage Box, any S3-compatible bucket, or an rclone
# remote of your own), and the `linear-hub` command for everyday jobs (status, update, go live, restore test).
#
# Safe to run again: every step checks what is already there and changes only what is missing or different. It never
# replaces the app key, the backup passphrase or the database. Answers are kept in /etc/linear-hub/install.conf, so a
# second run asks nothing new.
#
#   sudo bash install.sh                      # asks its questions
#   sudo bash install.sh --domain hub.example.co.uk --email you@example.co.uk --repo <url> --yes
#   bash install.sh --dry-run --yes ...       # shows what it would do; changes nothing, needs no root
#   bash install.sh --help
set -Eeuo pipefail
shopt -u patsub_replacement 2>/dev/null || true # bash 5.2: '&' in a replacement means the match; we want it literal

# ── fixed layout (the templates, the linear-hub command and docs/DEPLOY.md use the same paths) ──────────────────────
SERVICE_USER=linear
HOME_DIR=/opt/linear-hub
APP_DIR=$HOME_DIR/app
DATA_DIR=/var/lib/linear-hub
CONF_DIR=/etc/linear-hub
KEYS_DIR=$CONF_DIR/keys
ENV_FILE=$CONF_DIR/linear-hub.env
INSTALL_CONF=$CONF_DIR/install.conf
OFFSITE_CONF=$CONF_DIR/offsite.conf
LIB_DIR=/usr/local/lib/linear-hub
CLI_PATH=/usr/local/bin/linear-hub
RCLONE_CONF=$HOME_DIR/.config/rclone/rclone.conf
SSH_DIR=$HOME_DIR/.ssh
APP_PORT=''
NODE_MAJOR=22
NODE_MIN=22.18.0
LOG_FILE=/var/log/linear-hub-install.log

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMPLATES=$SCRIPT_DIR/templates

# ── answers and switches ───────────────────────────────────────────────────────────────────────────────────────────
DOMAIN=''
ACME_EMAIL=''
REPO_URL=''
REPO_REF=''
OFFSITE=''
OFFSITE_PATH=''
STORAGEBOX_HOST=''
STORAGEBOX_USER=''
S3_ENDPOINT=''
S3_BUCKET=''
S3_REGION=''
S3_ACCESS_KEY_ID=''
HEARTBEAT_URL=''
SSH_KEYS_ONLY=''
DRY_RUN=0
PREVIEW=''
ASSUME_YES=0
ALLOW_NO_SYSTEMD=0
HAVE_SYSTEMD=1
CHANGED=0
OFFSITE_READY=0
APP_ROOT=''
NODE_BIN=/usr/bin/node
NEW_PASSPHRASE=0 # 1: made this run; 2: made and shown on the screen

usage() {
  cat <<'EOF'
Linear Hub installer for a fresh Ubuntu 24.04 LTS server.

Usage: sudo bash install.sh [options]

Questions (asked when not given; kept for the next run):
  --domain NAME             the web address, e.g. hub.linear-mcr.co.uk (its DNS must point at this server)
  --email ADDRESS           where Let's Encrypt sends certificate notices
  --repo URL                the code repository (https://… or git@github.com:…; a private one gets a deploy key)
  --ref NAME                branch or release tag to install (default: main)
  --offsite KIND            storagebox | s3 | existing | none  (where encrypted backups are copied every night)
  --storagebox-host HOST    e.g. u123456.your-storagebox.de
  --storagebox-user USER    e.g. u123456 (or a sub-account such as u123456-sub1)
  --s3-endpoint URL         e.g. https://fsn1.your-objectstorage.com or https://s3.eu-west-2.amazonaws.com
  --s3-bucket NAME          the bucket (make it first, private)
  --s3-region NAME          optional, e.g. eu-west-2
  --s3-access-key-id ID     the access key; the secret comes from S3_SECRET_ACCESS_KEY or is asked (never shown)
  --offsite-path PATH       folder inside the off-site store (default: linear-hub)
  --heartbeat-url URL       optional: pinged after each good off-site copy (e.g. a Healthchecks.io check)
  --ssh-keys-only yes|no    turn off password log-in for SSH (only offered when an SSH key is set up)
  --port N                  the port Linear Hub listens on behind Caddy, on 127.0.0.1 only (default: 4000)

Switches:
  --yes                     do not ask; use the answers given or kept from the last run
  --dry-run                 change nothing: print the commands and write the files it would write to --preview
  --preview DIR             where a dry run writes its files (default: a new temporary folder)
  --allow-no-systemd        for testing in a container: write the services but do not start them, no firewall
  --help                    this text
EOF
}

# ── messages ───────────────────────────────────────────────────────────────────────────────────────────────────────
say() { printf '%s\n' "$*"; }
step() { printf '\n== %s ==\n' "$*"; }
ok() { printf '  ✔ %s\n' "$*"; }
note() { printf '  · %s\n' "$*"; }
warn() { printf '  ▲ %s\n' "$*" >&2; }
die() {
  printf '\n✖ %s\n' "$*" >&2
  if [[ $DRY_RUN == 0 && -w $LOG_FILE ]]; then printf '  The full log is in %s\n' "$LOG_FILE" >&2; fi
  exit 1
}

# ── checks on answers (pure; deploy/tests/run.sh tests them) ─────────────────────────────────────────────────────────
valid_domain() { [[ $1 =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$ ]] && ((${#1} <= 253)); }
valid_host() { valid_domain "$1"; }
valid_email() { [[ $1 =~ ^[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,}$ ]]; }
valid_ref() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$ && $1 != *..* ]]; }
valid_repo() { [[ $1 =~ ^(https://[^[:space:]\'\"]+|git@[A-Za-z0-9.-]+:[^[:space:]\'\"]+|ssh://[^[:space:]\'\"]+|file:///[^[:space:]\'\"]+|/[^[:space:]\'\"]+)$ ]]; }
valid_url() { [[ $1 =~ ^https://[^[:space:]\'\"]+$ ]]; }
valid_bucket() { [[ $1 =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; }
valid_path() { [[ $1 =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && $1 != *..* ]]; }
valid_user() { [[ $1 =~ ^[a-z0-9][a-z0-9_-]{0,31}$ ]]; }
valid_port() { [[ $1 =~ ^[0-9]{4,5}$ ]] && (($1 >= 1024 && $1 <= 65535)); }

# version_ge A B: true when version A >= version B (both like 22.18.0).
version_ge() { [[ $(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1) == "$2" ]]; }

# Node must be a long-term line Linear Hub is tested on (22.18 or newer, 24, 26).
node_version_ok() {
  local v=${1#v} major=${1#v}
  major=${major%%.*}
  case $major in
    22) version_ge "$v" "$NODE_MIN" ;;
    24 | 26) return 0 ;;
    *) return 1 ;;
  esac
}

# render TEMPLATE KEY=VALUE…: prints the template with each @KEY@ replaced; a placeholder left over is an error.
render() {
  local file=$1 content kv k v
  shift
  content=$(<"$file")
  for kv in "$@"; do
    k=${kv%%=*}
    v=${kv#*=}
    content=${content//"@${k}@"/"$v"}
  done
  if [[ $content =~ @[A-Z][A-Z0-9_]*@ ]]; then
    printf 'render: %s still has %s\n' "$file" "${BASH_REMATCH[0]}" >&2
    return 1
  fi
  printf '%s\n' "$content"
}

# read_kv FILE: prints KEY=VALUE lines of a settings file without running it (no `source`: a settings file is data).
read_kv() {
  [[ -r $1 ]] || return 0
  grep -E '^[A-Za-z_][A-Za-z0-9_]*=' "$1" || true
}

# kv_get FILE KEY: the value of KEY in a settings file, or nothing.
kv_get() {
  local line
  line=$(read_kv "$1" | grep -E "^$2=" | tail -n1) || true
  printf '%s' "${line#*=}"
}

# The settings the installer owns in the environment file. Anything else already there is kept.
managed_env() {
  cat <<EOF
TZ=Europe/London
NODE_NO_WARNINGS=1
HOST=127.0.0.1
PORT=$APP_PORT
DB_PATH=$DATA_DIR/linear.sqlite
LM_BACKUP_DIR=$DATA_DIR/backups
LM_STATEMENTS_DIR=$DATA_DIR/statements
LM_UPLOADS_DIR=$DATA_DIR/uploads
LM_APP_SECRET_FILE=$KEYS_DIR/app-secret
LM_OFFSITE_DIR=$DATA_DIR/offsite
LM_BACKUP_PASSPHRASE_FILE=$KEYS_DIR/backup-passphrase
TRUST_PROXY=1
COOKIE_SECURE=1
LM_DEMO_ACCOUNTS=0
EOF
}

# env_merge OLD_FILE: prints the new environment file. The installer's settings win; the owner's other settings stay;
# settings that must never be on a live server are dropped (and named on stderr).
env_merge() {
  local old=$1 line key managed_keys
  managed_keys=$(managed_env | cut -d= -f1 | tr '\n' ' ')
  cat <<'EOF'
# Linear Hub settings (read by the linear-hub service and the linear-hub command).
# Written by deploy/install.sh: the lines it owns are put back on every run; lines you add are kept.
# Never add LM_PAYMENTS_FAKE or LM_BUSINESS_NOW here (they are for demos), and keep LM_TLS_* unset: Caddy does HTTPS.
EOF
  managed_env
  while IFS= read -r line || [[ -n $line ]]; do
    [[ $line =~ ^([A-Za-z_][A-Za-z0-9_]*)= ]] || continue
    key=${BASH_REMATCH[1]}
    case " $managed_keys " in *" $key "*) continue ;; esac
    case $key in
      LM_PAYMENTS_FAKE | LM_BUSINESS_NOW)
        printf '  ▲ Removed %s from the settings: it is for demos and must never be set on a live server.\n' "$key" >&2
        continue
        ;;
      LM_TLS_CERT_FILE | LM_TLS_KEY_FILE)
        printf '  ▲ Removed %s from the settings: Caddy gives this server HTTPS, so Linear Hub must speak plain http on 127.0.0.1.\n' "$key" >&2
        continue
        ;;
      NODE_ENV)
        printf '  ▲ Removed NODE_ENV from the settings: the service sets it, and here it would stop updates installing the build tools.\n' >&2
        continue
        ;;
      LM_APP_SECRET)
        printf '  ▲ LM_APP_SECRET is set in %s: Linear Hub uses it instead of the key file. It is kept, because removing it would change the key. Ask Noryn to move it into %s.\n' "$ENV_FILE" "$KEYS_DIR/app-secret" >&2
        ;;
    esac
    printf '%s\n' "$line"
  done <"$old"
}

# ── doing things (every change goes through these, so --dry-run is honest) ─────────────────────────────────────────
log_cmd() { # the command as it would be typed, with secrets already masked by the caller
  if [[ $DRY_RUN == 1 ]]; then printf '%s\n' "$*" >>"$PREVIEW/COMMANDS"; fi
  printf '  $ %s\n' "$*"
}

run() {
  log_cmd "$*"
  [[ $DRY_RUN == 1 ]] && return 0
  "$@"
}

# run_sh "shell line": for the few steps that need a pipe. The line holds constants only.
run_sh() {
  log_cmd "$1"
  [[ $DRY_RUN == 1 ]] && return 0
  bash -c "$1"
}

linear_path() { printf '%s' "$(dirname "$NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"; }

# as_linear_exec DIR command…: run as the service user, in DIR, with a clean environment (no root variables leak in).
as_linear_exec() {
  local dir=$1
  shift
  (cd "$dir" && runuser -u "$SERVICE_USER" -- env -i HOME="$HOME_DIR" PATH="$(linear_path)" LANG=C.UTF-8 "$@")
}

# as_linear [--in DIR] command…: the same, printed first (and only printed in a dry run).
as_linear() {
  local dir=$HOME_DIR
  if [[ ${1:-} == --in ]]; then
    dir=$2
    shift 2
  fi
  log_cmd "runuser -u $SERVICE_USER -- (in $dir) $*"
  [[ $DRY_RUN == 1 ]] && return 0
  as_linear_exec "$dir" "$@"
}

# as_linear_masked "shown text" command…: for commands that carry a secret; the secret is never printed or logged.
as_linear_masked() {
  local shown=$1
  shift
  log_cmd "runuser -u $SERVICE_USER -- $shown"
  [[ $DRY_RUN == 1 ]] && return 0
  as_linear_exec "$HOME_DIR" "$@" >/dev/null
}

# as_linear_quiet: read-only checks, not printed (and never run in a dry run).
as_linear_quiet() {
  [[ $DRY_RUN == 1 ]] && return 1
  as_linear_exec "$HOME_DIR" "$@"
}

record_mode() { [[ $DRY_RUN == 1 ]] && printf '%s %s %s:%s\n' "$1" "$2" "$3" "$4" >>"$PREVIEW/MODES"; return 0; }

# make_dir PATH MODE OWNER GROUP
make_dir() {
  record_mode "$1" "$2" "$3" "$4"
  if [[ $DRY_RUN == 1 ]]; then
    mkdir -p "$PREVIEW$1"
    return 0
  fi
  if [[ -d $1 && $(stat -c '%a %U:%G' "$1") == "${2#0} $3:$4" ]]; then return 0; fi
  install -d -m "$2" -o "$3" -g "$4" "$1"
  note "folder $1 ($2, $3:$4)"
}

# put_file PATH MODE OWNER GROUP < content: writes only when different; sets CHANGED.
put_file() {
  local dest=$1 mode=$2 owner=$3 group=$4 tmp
  tmp=$(mktemp)
  cat >"$tmp"
  record_mode "$dest" "$mode" "$owner" "$group"
  if [[ $DRY_RUN == 1 ]]; then
    mkdir -p "$(dirname "$PREVIEW$dest")"
    mv "$tmp" "$PREVIEW$dest"
    note "would write $dest ($mode, $owner:$group)"
    return 0
  fi
  if [[ -f $dest ]] && cmp -s "$tmp" "$dest" && [[ $(stat -c '%a %U:%G' "$dest") == "${mode#0} $owner:$group" ]]; then
    rm -f "$tmp"
    return 1 # unchanged
  fi
  install -D -m "$mode" -o "$owner" -g "$group" "$tmp" "$dest"
  rm -f "$tmp"
  note "wrote $dest"
  CHANGED=1
  return 0
}

# random_text LENGTH: letters and digits without look-alikes (no 0, O, 1, I, L), from the kernel's random source.
random_text() {
  local alphabet=ABCDEFGHJKMNPQRSTUVWXYZ23456789 out='' byte
  while ((${#out} < $1)); do
    byte=$(od -An -N1 -tu1 /dev/urandom | tr -d ' ')
    ((byte < 248)) || continue # 248 = 31 × 8: keeps every letter equally likely
    out+=${alphabet:byte % 31:1}
  done
  printf '%s' "$out"
}

# ── step 0: checks before anything changes ─────────────────────────────────────────────────────────────────────────
preflight() {
  step "Checking this server"
  if [[ $DRY_RUN == 1 ]]; then
    note "dry run: not checking for root, Ubuntu 24.04 or systemd; nothing will be changed"
    mkdir -p "$PREVIEW"
    : >"$PREVIEW/COMMANDS"
    : >"$PREVIEW/MODES"
    return 0
  fi
  [[ $EUID == 0 ]] || die "Run it as root: sudo bash $0"
  local id='' version=''
  if [[ -r /etc/os-release ]]; then
    id=$(kv_get /etc/os-release ID | tr -d '"')
    version=$(kv_get /etc/os-release VERSION_ID | tr -d '"')
  fi
  [[ $id == ubuntu ]] || die "This installer is for Ubuntu 24.04 LTS (this server says: ${id:-unknown})."
  if [[ $version != 24.04 ]]; then
    warn "This installer was tested on Ubuntu 24.04 LTS; this server is $version."
    confirm "Carry on anyway?" n || die "Stopped. Nothing was changed."
  fi
  case $(dpkg --print-architecture) in amd64 | arm64) ;; *) die "Only amd64 and arm64 servers are supported." ;; esac
  if [[ ! -d /run/systemd/system ]]; then
    HAVE_SYSTEMD=0
    [[ $ALLOW_NO_SYSTEMD == 1 ]] || die "This machine is not running systemd (a container?). Linear Hub needs a normal server."
    warn "No systemd (test container): services are written but not started, and the firewall is left alone."
  fi
  exec 9>/run/linear-hub-install.lock
  flock -n 9 || die "The installer is already running in another window."
  touch "$LOG_FILE" && chmod 600 "$LOG_FILE"
  exec > >(tee -a "$LOG_FILE") 2>&1
  say "Started $(date -Is). Log: $LOG_FILE"
  ok "Ubuntu $version, $(dpkg --print-architecture)"
}

# ── step 1: the questions ──────────────────────────────────────────────────────────────────────────────────────────
interactive() { [[ $ASSUME_YES == 0 && -t 0 ]]; }

confirm() { # confirm "question" y|n
  local answer default=$2
  if ! interactive; then [[ $default == y ]]; return; fi
  read -r -p "  $1 [$([[ $default == y ]] && printf 'Y/n' || printf 'y/N')] " answer
  answer=${answer:-$default}
  [[ $answer =~ ^[Yy] ]]
}

# ask VAR "question" [default] validator "what is wrong"
ask() {
  local var=$1 question=$2 default=$3 check=$4 problem=$5 answer
  if [[ -n ${!var} ]]; then
    "$check" "${!var}" || die "${!var} $problem"
    return 0
  fi
  if ! interactive; then
    [[ -n $default ]] || die "No answer for: $question. Give it as an option (see --help)."
    printf -v "$var" '%s' "$default"
    return 0
  fi
  while true; do
    read -r -p "  $question${default:+ [$default]}: " answer
    answer=${answer:-$default}
    if "$check" "$answer"; then
      printf -v "$var" '%s' "$answer"
      return 0
    fi
    say "    $answer $problem. Try again."
  done
}

load_answers() {
  [[ -r $INSTALL_CONF ]] || return 0
  local k v line
  while IFS= read -r line; do
    k=${line%%=*}
    v=${line#*=}
    case $k in
      DOMAIN | ACME_EMAIL | REPO_URL | REPO_REF | OFFSITE | OFFSITE_PATH | STORAGEBOX_HOST | STORAGEBOX_USER | \
        S3_ENDPOINT | S3_BUCKET | S3_REGION | S3_ACCESS_KEY_ID | HEARTBEAT_URL | SSH_KEYS_ONLY | APP_PORT)
        [[ -n ${!k} ]] || printf -v "$k" '%s' "$v"
        ;;
    esac
  done < <(read_kv "$INSTALL_CONF")
}

gather_answers() {
  step "Questions"
  load_answers
  [[ -n $DOMAIN ]] || interactive || die "Give the web address with --domain (for example --domain hub.linear-mcr.co.uk)."
  ask DOMAIN "Web address for Linear Hub (e.g. hub.linear-mcr.co.uk)" "" valid_domain "is not a domain name (small letters, like hub.example.co.uk)"
  ask ACME_EMAIL "Email for HTTPS certificate notices" "" valid_email "is not an email address"
  ask REPO_URL "Code repository (Noryn gives you this)" "" valid_repo "is not a repository address"
  ask REPO_REF "Branch or release tag" "main" valid_ref "is not a branch or tag name"
  APP_PORT=${APP_PORT:-4000}
  valid_port "$APP_PORT" || die "--port must be a number from 1024 to 65535."
  if [[ -z $OFFSITE ]] && interactive; then
    say "  Where should the encrypted backups be copied every night?"
    say "    1) a Hetzner Storage Box   2) an S3-compatible bucket   3) an rclone remote already set up   4) nowhere yet"
    local pick
    read -r -p "  Choose 1-4 [1]: " pick
    case ${pick:-1} in 1) OFFSITE=storagebox ;; 2) OFFSITE=s3 ;; 3) OFFSITE=existing ;; 4) OFFSITE=none ;; *) OFFSITE=$pick ;; esac
  fi
  OFFSITE=${OFFSITE:-none}
  case $OFFSITE in
    storagebox)
      ask STORAGEBOX_HOST "Storage Box host (e.g. u123456.your-storagebox.de)" "" valid_host "is not a host name"
      ask STORAGEBOX_USER "Storage Box user (e.g. u123456)" "${STORAGEBOX_HOST%%.*}" valid_user "is not a user name"
      ask OFFSITE_PATH "Folder on the Storage Box" "linear-hub" valid_path "is not a folder name"
      ;;
    s3)
      [[ -n $S3_BUCKET ]] || interactive || die "Give the bucket with --s3-bucket."
      ask S3_ENDPOINT "S3 endpoint (https://…)" "" valid_url "is not an https:// address"
      ask S3_BUCKET "Bucket name" "" valid_bucket "is not a bucket name"
      ask S3_ACCESS_KEY_ID "Access key ID" "" valid_path "is not an access key ID"
      if [[ -n $S3_REGION ]] && ! valid_path "$S3_REGION"; then die "$S3_REGION is not a region name"; fi
      OFFSITE_PATH=${OFFSITE_PATH:-linear-hub}
      valid_path "$OFFSITE_PATH" || die "$OFFSITE_PATH is not a folder name"
      ;;
    existing)
      ask OFFSITE_PATH "Folder inside the remote called offsite" "linear-hub" valid_path "is not a folder name"
      ;;
    none) ;;
    *) die "--offsite must be storagebox, s3, existing or none (not '$OFFSITE')." ;;
  esac
  if [[ -n $HEARTBEAT_URL ]]; then valid_url "$HEARTBEAT_URL" || die "$HEARTBEAT_URL is not an https:// address"; fi
  if [[ -z $HEARTBEAT_URL ]] && interactive && [[ $OFFSITE != none ]]; then
    read -r -p "  Address to ping after each off-site copy (optional, Enter to skip): " HEARTBEAT_URL
    if [[ -n $HEARTBEAT_URL ]] && ! valid_url "$HEARTBEAT_URL"; then die "$HEARTBEAT_URL is not an https:// address"; fi
  fi
  case ${SSH_KEYS_ONLY:-} in '' | yes | no) ;; *) die "--ssh-keys-only must be yes or no." ;; esac
  ok "Linear Hub will answer at https://$DOMAIN"
  ok "Code: $REPO_URL ($REPO_REF)"
  ok "Off-site copies: $OFFSITE"
}

save_answers() {
  {
    say "# Answers given to deploy/install.sh (no secrets). Run the installer again to change them."
    for k in DOMAIN ACME_EMAIL REPO_URL REPO_REF APP_PORT OFFSITE OFFSITE_PATH STORAGEBOX_HOST STORAGEBOX_USER \
      S3_ENDPOINT S3_BUCKET S3_REGION S3_ACCESS_KEY_ID HEARTBEAT_URL SSH_KEYS_ONLY; do
      printf '%s=%s\n' "$k" "${!k}"
    done
  } | put_file "$INSTALL_CONF" 0600 root root || true
}

# ── step 2: system packages, swap, automatic security updates ───────────────────────────────────────────────────────
step_packages() {
  step "System packages"
  local wanted=(ca-certificates curl gnupg git ufw unattended-upgrades rclone openssh-client sqlite3) missing=()
  local p
  for p in "${wanted[@]}"; do
    if [[ $DRY_RUN == 1 || $(dpkg-query -W -f='${Status}' "$p" 2>/dev/null) != *'install ok installed'* ]]; then missing+=("$p"); fi
  done
  if ((${#missing[@]} == 0)); then
    ok "already installed"
    return 0
  fi
  run apt-get update -q
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}"
}

step_swap() {
  step "Memory for building"
  local mem_mb=0
  [[ -r /proc/meminfo ]] && mem_mb=$(($(awk '/^MemTotal:/{print $2}' /proc/meminfo) / 1024))
  if [[ $DRY_RUN == 0 ]] && { ((mem_mb >= 2000)) || [[ -n $(swapon --show --noheadings 2>/dev/null) ]] || [[ -e /swapfile ]]; }; then
    ok "${mem_mb} MB of memory$([[ -e /swapfile ]] && printf ' and a swap file')"
    return 0
  fi
  if [[ $HAVE_SYSTEMD == 0 ]]; then
    note "test container: no swap file"
    return 0
  fi
  note "under 2 GB of memory: adding a 2 GB swap file so building the app cannot run out"
  run fallocate -l 2G /swapfile
  run chmod 600 /swapfile
  run mkswap /swapfile
  run swapon /swapfile
  run_sh "grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab"
}

step_updates() {
  step "Automatic security updates"
  render "$TEMPLATES/20auto-upgrades" | put_file /etc/apt/apt.conf.d/20auto-upgrades 0644 root root || true
  render "$TEMPLATES/52linear-hub-unattended-upgrades" | put_file /etc/apt/apt.conf.d/52linear-hub-unattended-upgrades 0644 root root || true
  if [[ $HAVE_SYSTEMD == 1 ]]; then run systemctl enable --now unattended-upgrades.service; fi
  ok "security updates install every night; the server restarts itself at about 04:30 when an update needs it"
}

# ── step 3: firewall and SSH ───────────────────────────────────────────────────────────────────────────────────────
ssh_port() {
  local port=22
  if [[ $DRY_RUN == 0 ]] && command -v sshd >/dev/null 2>&1; then
    port=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}') || true
  fi
  printf '%s' "${port:-22}"
}

step_firewall() {
  step "Firewall: SSH, 80 and 443 only"
  if [[ $HAVE_SYSTEMD == 0 ]]; then
    note "test container: firewall left alone"
    return 0
  fi
  local port
  port=$(ssh_port)
  [[ $port == 22 ]] || warn "SSH listens on port $port here, so that port is opened instead of 22."
  run ufw default deny incoming
  run ufw default allow outgoing
  run ufw limit "$port/tcp" comment 'SSH (rate-limited)'
  run ufw allow 80/tcp comment 'HTTP (Caddy redirects to HTTPS)'
  run ufw allow 443/tcp comment 'HTTPS'
  run ufw allow 443/udp comment 'HTTPS (HTTP/3)'
  run ufw --force enable
  ok "incoming: SSH ($port), 80 and 443; everything else is refused"
}

# True when the person running the installer can log in with an SSH key (root, or the sudo user), so turning off
# password log-in cannot lock them out.
ssh_keys_present() {
  [[ $DRY_RUN == 1 ]] && return 0
  local home=/root
  if [[ -n ${SUDO_USER:-} && $SUDO_USER != root ]]; then home=$(getent passwd "$SUDO_USER" | cut -d: -f6); fi
  [[ -s $home/.ssh/authorized_keys ]] && grep -qE '^(ssh-|ecdsa-|sk-)' "$home/.ssh/authorized_keys"
}

step_ssh() {
  step "SSH log-in"
  if ! ssh_keys_present; then
    warn "No SSH key is set up for ${SUDO_USER:-root}, so password log-in stays on. Add a key, then run the installer again."
    return 0
  fi
  if [[ -z $SSH_KEYS_ONLY ]] && interactive; then
    if confirm "Turn off password log-in for SSH (keys only)? You keep logging in with your key." y; then SSH_KEYS_ONLY=yes; else SSH_KEYS_ONLY=no; fi
  fi
  if [[ $SSH_KEYS_ONLY != yes ]]; then
    note "password log-in left as it is"
    return 0
  fi
  # 10- sorts before cloud-init's 50-cloud-init.conf, and sshd keeps the first value it reads.
  if render "$TEMPLATES/10-linear-hub-sshd.conf" | put_file /etc/ssh/sshd_config.d/10-linear-hub.conf 0644 root root; then
    if [[ $DRY_RUN == 0 ]] && ! sshd -t; then
      rm -f /etc/ssh/sshd_config.d/10-linear-hub.conf
      die "The SSH settings did not check out, so they were taken back out. Nothing else changed in SSH."
    fi
    if [[ $HAVE_SYSTEMD == 1 ]]; then run systemctl reload ssh; fi
  fi
  ok "SSH accepts keys only"
}

# ── step 4: Node.js ────────────────────────────────────────────────────────────────────────────────────────────────
step_node() {
  step "Node.js $NODE_MAJOR LTS"
  if [[ $DRY_RUN == 0 ]] && command -v node >/dev/null 2>&1 && node_version_ok "$(node -v)"; then
    NODE_BIN=$(command -v node)
    ok "$(node -v) at $NODE_BIN"
    return 0
  fi
  run install -d -m 0755 /etc/apt/keyrings
  run_sh "curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg"
  render "$TEMPLATES/nodesource.list" NODE_MAJOR="$NODE_MAJOR" | put_file /etc/apt/sources.list.d/nodesource.list 0644 root root || true
  render "$TEMPLATES/nodesource.pref" | put_file /etc/apt/preferences.d/nodesource 0644 root root || true
  run apt-get update -q
  run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q nodejs
  if [[ $DRY_RUN == 0 ]]; then
    NODE_BIN=$(command -v node) || die "Node.js did not install."
    node_version_ok "$(node -v)" || die "Node.js $(node -v) is installed, but Linear Hub needs $NODE_MIN or newer on the $NODE_MAJOR line."
    ok "$(node -v)"
  fi
}

# ── step 5: the service user and its folders ───────────────────────────────────────────────────────────────────────
step_user_dirs() {
  step "Service user and folders"
  if [[ $DRY_RUN == 0 ]] && id -u "$SERVICE_USER" >/dev/null 2>&1; then
    ok "user $SERVICE_USER is there"
  else
    run useradd --system --user-group --home-dir "$HOME_DIR" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  make_dir "$HOME_DIR" 0750 "$SERVICE_USER" "$SERVICE_USER"
  make_dir "$SSH_DIR" 0700 "$SERVICE_USER" "$SERVICE_USER"
  make_dir "$HOME_DIR/.config" 0700 "$SERVICE_USER" "$SERVICE_USER"
  make_dir "$HOME_DIR/.config/rclone" 0700 "$SERVICE_USER" "$SERVICE_USER"
  make_dir "$DATA_DIR" 0700 "$SERVICE_USER" "$SERVICE_USER"
  local sub
  for sub in backups offsite media statements uploads logs; do make_dir "$DATA_DIR/$sub" 0700 "$SERVICE_USER" "$SERVICE_USER"; done
  # Settings: root's, readable by the service's group. Keys: the service's own, outside the data folder, so a copy
  # of the data folder (or a stolen disk image of it) never holds them.
  make_dir "$CONF_DIR" 0750 root "$SERVICE_USER"
  make_dir "$KEYS_DIR" 0700 "$SERVICE_USER" "$SERVICE_USER"
  make_dir "$LIB_DIR" 0755 root root
  ok "data in $DATA_DIR, keys in $KEYS_DIR, code in $APP_DIR"
}

# ── step 6: the code ───────────────────────────────────────────────────────────────────────────────────────────────
is_ssh_repo() { [[ $REPO_URL == git@* || $REPO_URL == ssh://* ]]; }
git_ssh_command() { printf 'ssh -i %s/deploy_ed25519 -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=%s/known_hosts' "$SSH_DIR" "$SSH_DIR"; }

step_code() {
  step "The code"
  if is_ssh_repo; then
    if [[ $DRY_RUN == 1 || ! -f $SSH_DIR/deploy_ed25519 ]]; then
      as_linear ssh-keygen -q -t ed25519 -N '' -C "linear-hub-deploy@$DOMAIN" -f "$SSH_DIR/deploy_ed25519"
    fi
    if ! as_linear_quiet env GIT_SSH_COMMAND="$(git_ssh_command)" git ls-remote --heads "$REPO_URL" >/dev/null 2>&1; then
      say "  This server needs read access to the private repository. Add this key on GitHub as a"
      say "  read-only deploy key (repository → Settings → Deploy keys → Add deploy key):"
      [[ $DRY_RUN == 1 ]] || say "    $(cat "$SSH_DIR/deploy_ed25519.pub")"
      if interactive; then read -r -p "  Press Enter once it is added… " _; fi
    fi
  fi
  if [[ $DRY_RUN == 0 && -d $APP_DIR/.git ]]; then
    ok "already cloned at $APP_DIR ($(as_linear_quiet git -C "$APP_DIR" describe --tags --always 2>/dev/null || printf 'unknown'))"
    note "updates go through: sudo linear-hub update (it backs up first)"
  else
    if is_ssh_repo; then
      as_linear env GIT_SSH_COMMAND="$(git_ssh_command)" git clone --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
      as_linear git -C "$APP_DIR" config core.sshCommand "$(git_ssh_command)"
    else
      as_linear git clone --branch "$REPO_REF" "$REPO_URL" "$APP_DIR"
    fi
    CHANGED=1
  fi
  if [[ $DRY_RUN == 1 || -f $APP_DIR/linear-micro-crm/package.json ]]; then
    APP_ROOT=$APP_DIR/linear-micro-crm
  elif [[ -f $APP_DIR/package.json ]]; then
    APP_ROOT=$APP_DIR
  else
    die "The repository has no Linear Hub in it (no package.json at the top or in linear-micro-crm/)."
  fi
  # npm run setup installs the exact packages from the lockfile and builds the screens, each only when needed.
  as_linear --in "$APP_ROOT" npm run setup
  ok "code ready in $APP_ROOT"
}

# ── step 7: the app key and the backup passphrase ──────────────────────────────────────────────────────────────────
# own_secret FILE: a key file put in place by hand (say, the passphrase typed from paper on a replacement server) is
# readable by the service and nobody else.
own_secret() {
  if [[ $(stat -c '%a %U:%G' "$1") != "600 $SERVICE_USER:$SERVICE_USER" ]]; then
    chown "$SERVICE_USER:$SERVICE_USER" "$1"
    chmod 600 "$1"
    note "$1 set to 600, $SERVICE_USER only"
  fi
}

step_keys() {
  step "App key and backup passphrase"
  local key=$KEYS_DIR/app-secret pass=$KEYS_DIR/backup-passphrase
  if [[ $DRY_RUN == 0 && -s $key ]]; then
    own_secret "$key"
    ok "app key: kept ($key)"
  elif [[ $DRY_RUN == 0 && -e $DATA_DIR/linear.sqlite ]]; then
    warn "There is a database but no app key at $key. A new key would make bank details and two-step sign-in unreadable,"
    warn "so none was made. Put the key back from the recovery sheet:  sudo linear-hub key:restore"
  else
    record_mode "$key" 0600 "$SERVICE_USER" "$SERVICE_USER"
    log_cmd "make a new random app key in $key (64 hex characters; never shown)"
    if [[ $DRY_RUN == 0 ]]; then
      (umask 077 && od -An -N32 -tx1 /dev/urandom | tr -d ' \n' >"$key" && printf '\n' >>"$key")
      chown "$SERVICE_USER:$SERVICE_USER" "$key"
      chmod 600 "$key"
      ok "app key made. The owner puts it on paper later: the recovery sheet (sudo linear-hub recovery-sheet)."
    fi
  fi
  if [[ $DRY_RUN == 0 && -s $pass ]]; then
    own_secret "$pass"
    ok "backup passphrase: kept ($pass)"
    return 0
  fi
  record_mode "$pass" 0600 "$SERVICE_USER" "$SERVICE_USER"
  log_cmd "make a new backup passphrase in $pass (six groups of five; shown once on the screen, never logged)"
  [[ $DRY_RUN == 1 ]] && return 0
  local phrase
  phrase=$(random_text 30 | sed -E 's/(.{5})/\1-/g; s/-$//')
  (umask 077 && printf '%s\n' "$phrase" >"$pass")
  chown "$SERVICE_USER:$SERVICE_USER" "$pass"
  chmod 600 "$pass"
  NEW_PASSPHRASE=1
  if [[ -t 0 ]] && { true >/dev/tty; } 2>/dev/null; then
    {
      printf '\n  ┌──────────────────────────────────────────────────────────────┐\n'
      printf '  │ OFF-SITE BACKUP PASSPHRASE — write it on paper now            │\n'
      printf '  │                                                              │\n'
      printf '  │   %-58s │\n' "$phrase"
      printf '  │                                                              │\n'
      printf '  │ Keep it apart from the recovery sheet. Without it the        │\n'
      printf '  │ off-site copies cannot be opened.                            │\n'
      printf '  └──────────────────────────────────────────────────────────────┘\n\n'
    } >/dev/tty
    if interactive; then
      local last=${phrase##*-} typed
      while true; do
        read -r -p "  Type the last group of five to show it is written down: " typed </dev/tty
        [[ ${typed^^} == "$last" ]] && break
        printf '  That is not the last group. Look again at the paper.\n' >/dev/tty
      done
    fi
    NEW_PASSPHRASE=2
    ok "backup passphrase made (it is not in the install log)"
  else
    ok "backup passphrase made. Read it once and write it down:  sudo cat $pass"
  fi
}

# ── step 8: the settings file ──────────────────────────────────────────────────────────────────────────────────────
step_env() {
  step "Settings ($ENV_FILE)"
  local old=/dev/null
  [[ $DRY_RUN == 0 && -f $ENV_FILE ]] && old=$ENV_FILE
  if env_merge "$old" | put_file "$ENV_FILE" 0600 root root; then :; else ok "unchanged"; fi
  ok "Linear Hub listens on 127.0.0.1:$APP_PORT only; Caddy is the way in"
}

# ── step 9: the service ────────────────────────────────────────────────────────────────────────────────────────────
wait_for_health() { # wait_for_health URL SECONDS
  local url=$1 tries=$(($2 / 2)) i
  for ((i = 0; i < tries; i++)); do
    [[ $(curl -fsS --max-time 5 "$url" 2>/dev/null) == *'"ok":true'* ]] && return 0
    sleep 2
  done
  return 1
}

step_service() {
  step "The Linear Hub service"
  local unit_changed=0
  if render "$TEMPLATES/linear-hub.service" SERVICE_USER="$SERVICE_USER" APP_ROOT="$APP_ROOT" ENV_FILE="$ENV_FILE" \
    DATA_DIR="$DATA_DIR" NODE_BIN="$NODE_BIN" | put_file /etc/systemd/system/linear-hub.service 0644 root root; then
    unit_changed=1
  fi
  if [[ $HAVE_SYSTEMD == 0 ]]; then
    note "test container: the service is written but not started"
    return 0
  fi
  [[ $unit_changed == 1 ]] && run systemctl daemon-reload
  run systemctl enable linear-hub.service
  if [[ $CHANGED == 1 ]]; then run systemctl restart linear-hub.service; else run systemctl start linear-hub.service; fi
  [[ $DRY_RUN == 1 ]] && return 0
  if wait_for_health "http://127.0.0.1:$APP_PORT/api/health" 90; then
    ok "running and answering on 127.0.0.1:$APP_PORT"
  else
    journalctl -u linear-hub.service -n 30 --no-pager || true
    die "Linear Hub did not answer within 90 seconds (its log is above). Fix that, then run the installer again."
  fi
}

# ── step 10: Caddy and HTTPS ───────────────────────────────────────────────────────────────────────────────────────
step_caddy() {
  step "HTTPS with Caddy for $DOMAIN"
  if [[ $DRY_RUN == 1 ]] || ! command -v caddy >/dev/null 2>&1; then
    run install -d -m 0755 /usr/share/keyrings
    run_sh "curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg"
    render "$TEMPLATES/caddy-stable.list" | put_file /etc/apt/sources.list.d/caddy-stable.list 0644 root root || true
    run apt-get update -q
    run env DEBIAN_FRONTEND=noninteractive apt-get install -y -q caddy
  else
    ok "Caddy $(caddy version 2>/dev/null | awk '{print $1}') is installed"
  fi
  local caddyfile=/etc/caddy/Caddyfile backup=''
  if [[ $DRY_RUN == 0 && -f $caddyfile ]]; then
    backup=$(mktemp)
    cp -p "$caddyfile" "$backup"
  fi
  if render "$TEMPLATES/Caddyfile" DOMAIN="$DOMAIN" ACME_EMAIL="$ACME_EMAIL" APP_PORT="$APP_PORT" |
    put_file "$caddyfile" 0644 root root; then
    if ! run caddy validate --config "$caddyfile" --adapter caddyfile; then
      if [[ -n $backup ]]; then cp -p "$backup" "$caddyfile"; fi
      die "Caddy did not accept the new Caddyfile, so the previous one was put back."
    fi
    if [[ $HAVE_SYSTEMD == 1 ]]; then
      run systemctl enable caddy.service
      run systemctl reload-or-restart caddy.service
    fi
  else
    ok "Caddyfile unchanged"
  fi
  [[ -n $backup ]] && rm -f "$backup"
  [[ $DRY_RUN == 1 || $HAVE_SYSTEMD == 0 ]] && return 0
  check_dns
  if wait_for_health "https://$DOMAIN/api/health" 90; then
    ok "https://$DOMAIN answers with a valid certificate"
  else
    warn "https://$DOMAIN does not answer yet. Usually the domain does not point at this server yet: Caddy keeps"
    warn "trying by itself once it does. Check with:  sudo linear-hub status"
  fi
}

check_dns() {
  local resolved mine
  resolved=$(getent ahosts "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ') || true
  mine=$(ip -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | tr '\n' ' ') || true
  if [[ -z $resolved ]]; then
    warn "$DOMAIN does not resolve yet. Add an A record pointing at this server ($mine) at your domain provider."
    return 0
  fi
  local a
  for a in $resolved; do
    if [[ " $mine " == *" $a "* ]]; then
      ok "$DOMAIN points at this server ($a)"
      return 0
    fi
  done
  note "$DOMAIN resolves to $resolved; this server has $mine (fine when the provider maps a public address)"
}

# ── step 11: off-site copies ───────────────────────────────────────────────────────────────────────────────────────
rclone_linear() { as_linear rclone --config "$RCLONE_CONF" "$@"; }
passphrase_text() { [[ $DRY_RUN == 1 ]] || tr -d '\n' <"$KEYS_DIR/backup-passphrase"; }
# (Output is read whole before matching: with pipefail, `| grep -q` can fail when grep stops reading early.)
remote_exists() {
  local remotes
  remotes=$(as_linear_quiet rclone --config "$RCLONE_CONF" listremotes 2>/dev/null) || return 1
  grep -qx "$1:" <<<"$remotes"
}

step_offsite() {
  step "Off-site copies of the backups"
  local target='' enabled=0
  case $OFFSITE in
    none)
      note "none chosen: the encrypted copies stay on this server until an off-site store is set up"
      ;;
    storagebox)
      target="offsite:$OFFSITE_PATH"
      local key=$SSH_DIR/offsite_ed25519 verb=create
      if [[ $DRY_RUN == 1 || ! -f $key ]]; then
        as_linear ssh-keygen -q -t ed25519 -N '' -C "linear-hub-offsite@$DOMAIN" -f "$key"
      fi
      remote_exists offsite && verb=update
      rclone_linear config "$verb" offsite sftp host="$STORAGEBOX_HOST" user="$STORAGEBOX_USER" port=23 \
        key_file="$key" known_hosts_file="$SSH_DIR/known_hosts" --non-interactive
      if [[ $DRY_RUN == 0 ]] && ! as_linear_quiet rclone --config "$RCLONE_CONF" mkdir "$target/backups" >/dev/null 2>&1; then
        say "  The Storage Box does not know this server's key yet. Turn on SSH support for the Storage Box in"
        say "  the Hetzner console, then type its password once when asked (it is not stored)."
        if interactive; then
          as_linear ssh-copy-id -s -p 23 -i "$key.pub" -o StrictHostKeyChecking=accept-new \
            -o UserKnownHostsFile="$SSH_DIR/known_hosts" "$STORAGEBOX_USER@$STORAGEBOX_HOST" || true
        else
          say "  Or add this key in the Hetzner console:  $(cat "$key.pub")"
        fi
      fi
      ;;
    s3)
      target="offsite:$S3_BUCKET/$OFFSITE_PATH"
      local secret=${S3_SECRET_ACCESS_KEY:-}
      if remote_exists offsite && [[ -z $secret ]]; then
        ok "the remote 'offsite' is already set up (give S3_SECRET_ACCESS_KEY to change its keys)"
      else
        if [[ -z $secret && $DRY_RUN == 0 ]]; then
          interactive || die "Give the bucket's secret key in S3_SECRET_ACCESS_KEY (it is never shown or saved in the answers)."
          read -r -s -p "  Secret access key (not shown): " secret
          printf '\n'
        fi
        local args=(offsite s3 provider=Other endpoint="$S3_ENDPOINT" access_key_id="$S3_ACCESS_KEY_ID" acl=private
          no_check_bucket=true)
        [[ -n $S3_REGION ]] && args+=(region="$S3_REGION")
        local verb=create
        remote_exists offsite && verb=update
        as_linear_masked "rclone --config $RCLONE_CONF config $verb ${args[*]} secret_access_key=*** --non-interactive" \
          rclone --config "$RCLONE_CONF" config "$verb" "${args[@]}" secret_access_key="$secret" --non-interactive
      fi
      ;;
    existing)
      target="offsite:$OFFSITE_PATH"
      if [[ $DRY_RUN == 0 ]] && ! remote_exists offsite; then
        warn "There is no rclone remote called 'offsite' for the $SERVICE_USER user yet. Make one with:"
        warn "  sudo -u $SERVICE_USER rclone --config $RCLONE_CONF config     (name it offsite), then run the installer again."
        target=''
      fi
      ;;
  esac
  if [[ -n $target ]]; then
    enabled=1
    # Learning videos are not inside the nightly backup (they are large), so they get their own encrypted copy,
    # locked with the same passphrase as the backups.
    # (rclone takes the password as an argument for a moment; on this single-purpose server only root could see it.)
    local mverb=create
    remote_exists offsite-media && mverb=update
    local media_now=''
    [[ $mverb == update ]] && media_now=$(as_linear_quiet rclone --config "$RCLONE_CONF" config show offsite-media 2>/dev/null)
    if grep -qx "remote = $target/media-encrypted" <<<"$media_now"; then
      ok "the encrypted copy of the learning videos is set up"
    else
      local media_args=(offsite-media crypt remote="$target/media-encrypted" filename_encryption=standard
        directory_name_encryption=true)
      as_linear_masked "rclone --config $RCLONE_CONF config $mverb ${media_args[*]} password=*** --obscure --non-interactive" \
        rclone --config "$RCLONE_CONF" config "$mverb" "${media_args[@]}" password="$(passphrase_text)" --obscure --non-interactive
    fi
    if [[ $DRY_RUN == 1 ]]; then
      rclone_linear mkdir "$target/backups"
      OFFSITE_READY=1
    elif as_linear_quiet rclone --config "$RCLONE_CONF" mkdir "$target/backups" >/dev/null 2>&1; then
      ok "connected to $target"
      OFFSITE_READY=1
    else
      warn "Could not reach $target yet. The copies wait on this server; run the installer again once it is reachable."
    fi
  fi
  render "$TEMPLATES/offsite.conf" ENABLED="$enabled" TARGET="$target" HEARTBEAT_URL="$HEARTBEAT_URL" \
    OFFSITE_DIR="$DATA_DIR/offsite" MEDIA_DIR="$DATA_DIR/media" RCLONE_CONF="$RCLONE_CONF" \
    STATUS_FILE="$DATA_DIR/offsite-sync.status" | put_file "$OFFSITE_CONF" 0640 root "$SERVICE_USER" || true
  render "$TEMPLATES/offsite-sync.sh" OFFSITE_CONF="$OFFSITE_CONF" | put_file "$LIB_DIR/offsite-sync.sh" 0755 root root || true
  render "$TEMPLATES/linear-hub-offsite.service" SERVICE_USER="$SERVICE_USER" LIB_DIR="$LIB_DIR" DATA_DIR="$DATA_DIR" \
    HOME_DIR="$HOME_DIR" | put_file /etc/systemd/system/linear-hub-offsite.service 0644 root root || true
  render "$TEMPLATES/linear-hub-offsite.timer" | put_file /etc/systemd/system/linear-hub-offsite.timer 0644 root root || true
  if [[ $HAVE_SYSTEMD == 1 ]]; then
    run systemctl daemon-reload
    if [[ $enabled == 1 ]]; then
      run systemctl enable --now linear-hub-offsite.timer
    else
      run systemctl disable --now linear-hub-offsite.timer
    fi
  fi
  [[ $enabled == 1 ]] && ok "every night at 03:15 (London) the encrypted backups are copied to $target"
  return 0
}

# ── step 12: the linear-hub command ────────────────────────────────────────────────────────────────────────────────
step_cli() {
  step "The linear-hub command"
  render "$TEMPLATES/linear-hub" SERVICE_USER="$SERVICE_USER" HOME_DIR="$HOME_DIR" APP_ROOT="$APP_ROOT" \
    ENV_FILE="$ENV_FILE" DATA_DIR="$DATA_DIR" OFFSITE_CONF="$OFFSITE_CONF" DOMAIN="$DOMAIN" \
    APP_PORT="$APP_PORT" NODE_BIN="$NODE_BIN" RCLONE_CONF="$RCLONE_CONF" | put_file "$CLI_PATH" 0755 root root || true
  ok "sudo linear-hub help   lists what it does"
}

summary() {
  step "Done"
  [[ $DRY_RUN == 1 ]] && say "Dry run: nothing was changed. The files it would write are in $PREVIEW and the commands in $PREVIEW/COMMANDS."
  cat <<EOF

  Linear Hub:               https://$DOMAIN
  Health check (for an uptime monitor such as UptimeRobot or Better Stack; expect "ok":true):
                            https://$DOMAIN/api/health
  Everyday jobs:            sudo linear-hub help

  Next (docs/DEPLOY.md, "Go-live day"):
    1. Bring the trial database:   sudo linear-hub import /path/to/linear-….lhbk
    2. Go live:                    sudo linear-hub golive
    3. The owner prints the recovery sheet (Settings › Backups, or sudo linear-hub recovery-sheet)
    4. Test a restore:             sudo linear-hub restore-test
EOF
  if [[ $OFFSITE == none || $OFFSITE_READY == 0 ]]; then
    say ""
    warn "Off-site copies are not set up: the encrypted backups stay on this server. If the server is lost, so are they."
    warn "Run the installer again with --offsite storagebox (or s3) to fix that."
  fi
  if [[ $NEW_PASSPHRASE == 2 ]]; then
    say ""
    say "  Remember: the off-site passphrase shown above goes on paper, apart from the recovery sheet."
  elif [[ $NEW_PASSPHRASE == 1 ]]; then
    say ""
    say "  Read the new off-site passphrase once and write it on paper, apart from the recovery sheet:"
    say "    sudo cat $KEYS_DIR/backup-passphrase"
  fi
}

parse_args() {
  while (($#)); do
    case $1 in
      --domain) DOMAIN=${2:-}; shift ;;
      --email) ACME_EMAIL=${2:-}; shift ;;
      --repo) REPO_URL=${2:-}; shift ;;
      --ref) REPO_REF=${2:-}; shift ;;
      --offsite) OFFSITE=${2:-}; shift ;;
      --offsite-path) OFFSITE_PATH=${2:-}; shift ;;
      --storagebox-host) STORAGEBOX_HOST=${2:-}; shift ;;
      --storagebox-user) STORAGEBOX_USER=${2:-}; shift ;;
      --s3-endpoint) S3_ENDPOINT=${2:-}; shift ;;
      --s3-bucket) S3_BUCKET=${2:-}; shift ;;
      --s3-region) S3_REGION=${2:-}; shift ;;
      --s3-access-key-id) S3_ACCESS_KEY_ID=${2:-}; shift ;;
      --heartbeat-url) HEARTBEAT_URL=${2:-}; shift ;;
      --ssh-keys-only) SSH_KEYS_ONLY=${2:-}; shift ;;
      --port) APP_PORT=${2:-}; shift ;;
      --yes | -y) ASSUME_YES=1 ;;
      --dry-run) DRY_RUN=1 ;;
      --preview) PREVIEW=${2:-}; shift ;;
      --allow-no-systemd) ALLOW_NO_SYSTEMD=1 ;;
      --help | -h) usage; exit 0 ;;
      *) die "Unknown option: $1 (see --help)" ;;
    esac
    shift
  done
  if [[ $DRY_RUN == 1 ]]; then
    PREVIEW=${PREVIEW:-$(mktemp -d)}
    HAVE_SYSTEMD=1
  fi
}

main() {
  parse_args "$@"
  trap 'die "Stopped at line $LINENO: $BASH_COMMAND"' ERR
  preflight
  gather_answers
  step_packages
  step_swap
  step_updates
  step_firewall
  step_ssh
  step_node
  step_user_dirs
  save_answers
  step_code
  step_keys
  step_env
  step_service
  step_caddy
  step_offsite
  step_cli
  summary
}

# One line, so bash has read it all before main runs (the script may be replaced while it runs).
if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; exit $?; fi
