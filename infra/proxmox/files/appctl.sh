#!/usr/bin/env bash
# __APP_NAME__ctl — runs the __APP_NAME__ stack inside the Proxmox LXC created by infra/proxmox.
# Installed at /usr/local/bin/__APP_NAME__ctl by Terraform. Every command is idempotent.
#
#   __APP_NAME__ctl deploy [--auto-update true|false] [--interval 15min]
#       Install Docker if missing, pull our images, `compose up -d`, wait for the one-shot service if any.
#   __APP_NAME__ctl update     Pull our images, redeploy only if one changed (run by the update timer).
#   __APP_NAME__ctl status     docker compose ps
#   __APP_NAME__ctl logs [svc] Follow logs (all services, or one).
#   __APP_NAME__ctl compose …  Any other docker compose command against the stack (exec, restart, …).
#   __APP_NAME__ctl import-db <file>  Replace the bks database with <file> (SQLite, taken with the backup API).
#   __APP_NAME__ctl admin-filter apply|remove|status  Firewall of the admin port (9890), see below.
set -euo pipefail

APP="__APP_NAME__"
# Rendered by Terraform (deploy.tf). Only these images (+ cloudflared) are pulled by deploy/update:
# databases stay on the version pulled at first deploy (unattended major upgrades break data dirs).
UPDATE_SERVICES="__UPDATE_SERVICES__"
WAIT_SERVICE="__WAIT_SERVICE__"

STACK_DIR="/opt/$APP"
COMPOSE=(docker compose --project-name "$APP" --project-directory "$STACK_DIR" -f "$STACK_DIR/compose.yml" -f "$STACK_DIR/compose.proxmox.yml")

log() { printf '[%sctl] %s\n' "$APP" "$*"; }
die() { printf '[%sctl] ERROR: %s\n' "$APP" "$*" >&2; exit 1; }

apt_get() { DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 -y -q "$@"; }

wait_for_network() {
  for _ in $(seq 1 60); do
    getent hosts download.docker.com >/dev/null 2>&1 && return 0
    sleep 2
  done
  die "no DNS resolution after 120s — check the bridge gateway / NAT on the Proxmox host"
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return 0
  fi
  log "installing Docker Engine + Compose plugin"
  wait_for_network

  # Written before the install so the daemon starts with it:
  # - rotated logs (the default json-file driver grows forever);
  # - the classic image store. Since Docker 29 images default to containerd's store in /var/lib/containerd,
  #   i.e. on the small rootfs, not on the /var/lib/docker volume sized for them.
  install -d -m 0755 /etc/docker
  if [[ ! -f /etc/docker/daemon.json ]]; then
    cat >/etc/docker/daemon.json <<'JSON'
{
  "log-driver": "local",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "features": { "containerd-snapshotter": false }
}
JSON
  fi

  # shellcheck disable=SC1091
  . /etc/os-release
  apt_get update
  apt_get install ca-certificates curl
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt_get update
  apt_get install docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
}

wait_for_docker() {
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && return 0
    sleep 2
  done
  die "Docker daemon not ready after 60s (journalctl -u docker)"
}

# Our services that are active in the current config (profiles applied), sorted: `config --services`
# returns them in a different order on each call, and cmd_update compares two listings.
app_services() {
  local active s
  active="$("${COMPOSE[@]}" config --services)"
  for s in $UPDATE_SERVICES cloudflared; do
    if grep -qx "$s" <<<"$active"; then echo "$s"; fi
  done | sort -u
}

image_ids() {
  local svc img
  for svc in $(app_services); do
    img="$("${COMPOSE[@]}" config --images "$svc" 2>/dev/null | head -n1)"
    printf '%s %s\n' "$svc" "$(docker image inspect -f '{{.Id}}' "$img" 2>/dev/null || echo none)"
  done
}

install_timer() {
  local enabled="$1" interval="$2"
  if [[ "$enabled" != "true" ]]; then
    systemctl disable --now "$APP-update.timer" >/dev/null 2>&1 || true
    return 0
  fi
  cat >"/etc/systemd/system/$APP-update.service" <<UNIT
[Unit]
Description=Pull new $APP images and redeploy when they changed
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/${APP}ctl update
UNIT
  cat >"/etc/systemd/system/$APP-update.timer" <<UNIT
[Unit]
Description=Check for new $APP images every ${interval}

[Timer]
OnBootSec=5min
OnUnitActiveSec=${interval}
RandomizedDelaySec=60

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now "$APP-update.timer" >/dev/null
}

wait_for_oneshot() {
  [[ -n "$WAIT_SERVICE" ]] || return 0
  local cid rc
  cid="$("${COMPOSE[@]}" ps -a -q "$WAIT_SERVICE")"
  [[ -n "$cid" ]] || die "$WAIT_SERVICE container not found"
  log "waiting for $WAIT_SERVICE (first boot of the databases can take a few minutes)"
  rc="$(timeout 1200 docker wait "$cid")" || die "$WAIT_SERVICE still running after 20 min: ${APP}ctl logs $WAIT_SERVICE"
  if [[ "$rc" != "0" ]]; then
    "${COMPOSE[@]}" logs --tail 80 "$WAIT_SERVICE" >&2 || true
    die "$WAIT_SERVICE exited with code $rc"
  fi
  log "$WAIT_SERVICE done"
}

# --- bks: admin port ---------------------------------------------------------------------------------
# The local interface (9890) has no authentication. When it is published on the CT's address (ADMIN_BIND in
# .env), only the Proxmox host (ADMIN_ALLOW) may reach it: DOCKER-USER sees published ports after DNAT, so
# match on the original destination port.
env_value() { sed -n "s/^$1=//p" "$STACK_DIR/.env" | tail -n1; }
admin_rule() { echo "-i eth0 -p tcp -m conntrack --ctorigdstport 9890 ! -s $(env_value ADMIN_ALLOW) -j DROP"; }

cmd_admin_filter() {
  local bind
  bind="$(env_value ADMIN_BIND)"
  case "${1:-status}" in
    apply)
      if [[ -z "$bind" || "$bind" == "127.0.0.1" ]]; then
        log "admin port on loopback only: no filter needed"
        return 0
      fi
      [[ -n "$(env_value ADMIN_ALLOW)" ]] || die "ADMIN_ALLOW missing from .env"
      # shellcheck disable=SC2046
      iptables -C DOCKER-USER $(admin_rule) 2>/dev/null || iptables -I DOCKER-USER $(admin_rule)
      ;;
    remove)
      # shellcheck disable=SC2046
      while iptables -D DOCKER-USER $(admin_rule) 2>/dev/null; do :; done
      ;;
    status) iptables -S DOCKER-USER ;;
    *) die "admin-filter apply|remove|status" ;;
  esac
}

install_admin_filter() {
  cat >"/etc/systemd/system/$APP-admin-filter.service" <<UNIT
[Unit]
Description=Only the Proxmox host may reach the $APP admin port (9890)
After=docker.service
Requires=docker.service
PartOf=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/${APP}ctl admin-filter apply
ExecStop=/usr/local/bin/${APP}ctl admin-filter remove

[Install]
WantedBy=docker.service
UNIT
  systemctl daemon-reload
  systemctl enable "$APP-admin-filter.service" >/dev/null
  systemctl restart "$APP-admin-filter.service"
  local bind
  bind="$(env_value ADMIN_BIND)"
  if [[ -n "$bind" && "$bind" != "127.0.0.1" ]]; then
    # shellcheck disable=SC2046
    iptables -C DOCKER-USER $(admin_rule) 2>/dev/null || die "admin port filter not in place: refusing to publish 9890 on $bind"
    log "admin port 9890 on $bind, reachable from $(env_value ADMIN_ALLOW) only"
  fi
}

cmd_import_db() {
  local src="${1:-}"
  [[ -n "$src" && -f "$src" ]] || die "import-db <file>: file not found"
  head -c 16 "$src" | grep -q '^SQLite format 3' || die "$src is not an SQLite database"
  log "stopping bks"
  "${COMPOSE[@]}" stop bks
  log "replacing /data/bank.db (previous one kept as bank.db.before-import)"
  "${COMPOSE[@]}" run --rm --no-deps --user 0 --entrypoint sh -v "$src:/in/bank.db:ro" bks -c '
    set -e
    if [ -f /data/bank.db ]; then cp /data/bank.db /data/bank.db.before-import; fi
    rm -f /data/bank.db /data/bank.db-wal /data/bank.db-shm
    cp /in/bank.db /data/bank.db
    chown 10001:10001 /data/bank.db /data/bank.db.before-import 2>/dev/null || chown 10001:10001 /data/bank.db
    chmod 0600 /data/bank.db'
  rm -f "$src"
  "${COMPOSE[@]}" up -d bks
  sleep 3
  "${COMPOSE[@]}" logs --tail 20 bks
}

cmd_deploy() {
  local auto_update="true" interval="15min"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --auto-update) auto_update="$2"; shift 2 ;;
      --interval) interval="$2"; shift 2 ;;
      *) die "deploy: unknown option $1" ;;
    esac
  done

  [[ -f "$STACK_DIR/.env" ]] || die "$STACK_DIR/.env missing (it is pushed by Terraform)"
  install_docker
  wait_for_docker
  install_timer "$auto_update" "$interval"
  install_admin_filter

  log "validating compose config"
  "${COMPOSE[@]}" config --quiet

  local services=()
  mapfile -t services < <(app_services)
  if [[ ${#services[@]} -gt 0 ]]; then
    log "pulling ${services[*]}"
    "${COMPOSE[@]}" pull --quiet "${services[@]}"
  fi

  # Other images are pulled by `up` only if missing (default pull policy).
  log "starting stack"
  "${COMPOSE[@]}" up -d --remove-orphans
  wait_for_oneshot
  "${COMPOSE[@]}" ps
}

cmd_update() {
  wait_for_docker
  local services=() before after
  mapfile -t services < <(app_services)
  if [[ ${#services[@]} -eq 0 ]]; then
    log "no auto-updated service"
    return 0
  fi
  before="$(image_ids)"
  "${COMPOSE[@]}" pull --quiet "${services[@]}"
  after="$(image_ids)"
  if [[ "$before" == "$after" ]]; then
    log "no new image"
    return 0
  fi
  log "new images:"
  diff <(echo "$before") <(echo "$after") | grep '^>' || true
  "${COMPOSE[@]}" up -d --remove-orphans
  docker image prune -f >/dev/null
}

main() {
  local cmd="${1:-}"
  shift || true
  case "$cmd" in
    deploy) cmd_deploy "$@" ;;
    update) cmd_update ;;
    status) "${COMPOSE[@]}" ps ;;
    logs) "${COMPOSE[@]}" logs -f --tail 100 "$@" ;;
    compose) "${COMPOSE[@]}" "$@" ;;
    import-db) cmd_import_db "$@" ;;
    admin-filter) cmd_admin_filter "$@" ;;
    *) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; [[ -z "$cmd" ]] || exit 1 ;;
  esac
}

main "$@"
