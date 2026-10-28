#!/usr/bin/env bash
# Linear Hub (written by deploy/install.sh): copies the encrypted backups off this server.
#
# Linear Hub writes an encrypted copy of every backup (linear-….lhbk: the database, the uploaded files and the app key,
# locked with the backup passphrase) into its off-site folder. This copies those files to the off-site store, and the
# learning videos (which are too big for the nightly backup) through rclone's own encryption with the same passphrase.
# It never deletes anything there: `rclone copy`, not `rclone sync`, so an empty or damaged folder on this server can
# never wipe the copies. Run every night by linear-hub-offsite.timer as the service user; `sudo linear-hub
# offsite-sync` runs it now. The result goes to the status file (read by `sudo linear-hub status`), and a heartbeat
# address, when set, is pinged only after a good copy, so an uptime monitor notices a night that failed.
set -Euo pipefail

CONF=@OFFSITE_CONF@

setting() { grep -E "^$1=" "$CONF" 2>/dev/null | tail -n1 | cut -d= -f2-; }

enabled=$(setting OFFSITE_ENABLED)
target=$(setting OFFSITE_TARGET)
offsite_dir=$(setting OFFSITE_DIR)
media_dir=$(setting MEDIA_DIR)
rclone_conf=$(setting RCLONE_CONF)
status_file=$(setting STATUS_FILE)
heartbeat=$(setting HEARTBEAT_URL)

record() { # record ok|failed|off "what happened"
  [[ -n $status_file ]] || return 0
  printf '%s %s %s\n' "$1" "$(date -Is)" "$2" >"$status_file.tmp" && mv "$status_file.tmp" "$status_file"
}

if [[ $enabled != 1 || -z $target ]]; then
  echo "Off-site copies are not set up (run deploy/install.sh with --offsite)."
  record off "not set up"
  exit 0
fi

count=$(find "$offsite_dir" -maxdepth 1 -type f -name 'linear-*.lhbk' 2>/dev/null | wc -l)
if ((count == 0)); then
  echo "No encrypted backups in $offsite_dir yet: Linear Hub writes one after each backup (the first ten minutes after it starts, then nightly)."
fi

# --size-only: compare by size (each name carries its time, and a finished copy never changes). A copy cut off half-way
# (a dropped connection, the 04:30 restart) is shorter than the file here, so the next night sends it again.
if ! rclone --config "$rclone_conf" copy "$offsite_dir" "$target/backups" --include 'linear-*.lhbk' \
  --size-only --log-level NOTICE; then
  record failed "could not copy the backups to $target"
  echo "Could not copy the backups to $target." >&2
  exit 1
fi

if [[ -d $media_dir ]] && [[ -n $(find "$media_dir" -type f -print -quit 2>/dev/null) ]]; then
  # *.upload: a video still being uploaded to Linear Hub (renamed when it is complete).
  if ! rclone --config "$rclone_conf" copy "$media_dir" offsite-media: --exclude '*.upload' --size-only --log-level NOTICE; then
    record failed "the backups were copied, but the learning videos were not"
    echo "Could not copy the learning videos." >&2
    exit 1
  fi
fi

record ok "$count encrypted backups in the off-site folder, copied to $target"
echo "Copied to $target ($count encrypted backups here)."
if [[ -n $heartbeat ]]; then
  curl -fsS -m 10 --retry 3 -o /dev/null "$heartbeat" || echo "The heartbeat address did not answer." >&2
fi
exit 0
