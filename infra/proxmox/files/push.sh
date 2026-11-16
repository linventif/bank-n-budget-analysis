#!/usr/bin/env bash
# Runs on the Proxmox host, over SSH, from terraform_data.deploy (infra/proxmox/deploy.tf).
# Unpacks the bundle staged by Terraform, copies it into the CT, then runs `<app>ctl deploy` inside it.
#
#   push.sh <vmid> <staging-dir> <app-name> [<app>ctl deploy options…]
#
# The staging dir holds the rendered .env, so it is removed whatever happens.
set -euo pipefail

# Terraform's remote-exec runs this under a PTY. pct exec (lxc-attach) then gives the command a pty of its
# own, and the command ends with SIGHUP (exit 129) even when it succeeded. Run detached from any terminal.
if [ -t 0 ] || [ -t 1 ] || [ -t 2 ]; then
  bash "$0" "$@" </dev/null 2>&1 | cat
  exit "${PIPESTATUS[0]}"
fi

VMID="$1"
STAGING="$2"
APP="$3"
shift 3
trap 'rm -rf "$STAGING"' EXIT

DEST="/opt/$APP"

# Default umask on purpose: config files may be bind-mounted into non-root containers. The staging dir is
# 0700, and the two secret files are chmod 0600 once in the CT.
(cd "$STAGING" && bash unpack.sh)
tar -C "$STAGING/payload" -czf "$STAGING/payload.tgz" .

if ! pct status "$VMID" | grep -q 'status: running'; then
  echo "[push] starting CT $VMID"
  pct start "$VMID"
fi
# pct exec fails while the CT's init is still coming up right after creation/start.
for _ in $(seq 1 30); do
  pct exec "$VMID" -- true >/dev/null 2>&1 && break
  sleep 2
done

echo "[push] copying bundle into CT $VMID:$DEST"
pct exec "$VMID" -- install -d -m 0700 "$DEST"
pct push "$VMID" "$STAGING/payload.tgz" /root/payload.tgz --perms 0600
pct exec "$VMID" -- sh -c "tar --no-overwrite-dir -xzf /root/payload.tgz -C '$DEST' && rm -f /root/payload.tgz && chmod 0600 '$DEST/.env' '$DEST/cloudflared.env'"
# bks : config.toml et eb.pem montés en lecture seule dans un conteneur qui tourne sous l'uid BKS_UID.
pct exec "$VMID" -- sh -c "chown '${BKS_UID:?}:${BKS_UID}' '$DEST/config.toml' '$DEST/eb.pem' && chmod 0400 '$DEST/config.toml' '$DEST/eb.pem'"
pct push "$VMID" "$STAGING/appctl.sh" "/usr/local/bin/${APP}ctl" --perms 0755
# pct exec runs with PATH=/sbin:/bin:/usr/sbin:/usr/bin: make `pct exec <vmid> -- <app>ctl …` work.
pct exec "$VMID" -- ln -sf "/usr/local/bin/${APP}ctl" "/usr/sbin/${APP}ctl"

echo "[push] ${APP}ctl deploy $*"
pct exec "$VMID" -- "/usr/local/bin/${APP}ctl" deploy "$@"
