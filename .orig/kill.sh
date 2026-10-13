#!/usr/bin/env bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORAGE_DIR="${ROOT_DIR}/storage"
RUNTIME_DIR="${STORAGE_DIR}/runtime"
NGINX_DIR="${ROOT_DIR}/nginx"
BACKEND_PID_FILE="${RUNTIME_DIR}/backend.pid"
NGINX_PID_FILE="${RUNTIME_DIR}/nginx.pid"

PUBLIC_PORT="${PUBLIC_PORT:-27715}"
BACKEND_PORT="${BACKEND_PORT:-17156}"
QUIET="${1:-}"

log() {
  if [[ "${QUIET}" != "--quiet" ]]; then
    echo "$@"
  fi
}

log "==> Stopping workerd runtime services..."

# 1. Stop Nginx reverse proxy (:8080) & any system nginx daemon holding the port
if [[ -f "${NGINX_PID_FILE}" ]]; then
  NGINX_PID="$(cat "${NGINX_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${NGINX_PID}" ]] && kill -0 "${NGINX_PID}" 2>/dev/null; then
    nginx -c "${NGINX_DIR}/nginx.conf" -e "${RUNTIME_DIR}/nginx-error.log" -s quit 2>/dev/null ||
      kill -TERM "${NGINX_PID}" 2>/dev/null ||
      sudo -n kill -TERM "${NGINX_PID}" 2>/dev/null || true
    log "==> Stopped nginx reverse proxy (PID ${NGINX_PID})"
  fi
  rm -f "${NGINX_PID_FILE}"
fi

pkill -f "nginx -c ${NGINX_DIR}/nginx.conf" 2>/dev/null || sudo -n pkill -f "nginx -c ${NGINX_DIR}/nginx.conf" 2>/dev/null || true
sudo -n systemctl stop nginx 2>/dev/null || sudo -n service nginx stop 2>/dev/null || true

# 2. Stop Backend Server (:8787)
if [[ -f "${BACKEND_PID_FILE}" ]]; then
  BACKEND_PID="$(cat "${BACKEND_PID_FILE}" 2>/dev/null || true)"
  if [[ -n "${BACKEND_PID}" ]] && kill -0 "${BACKEND_PID}" 2>/dev/null; then
    kill -TERM "${BACKEND_PID}" 2>/dev/null || sudo -n kill -TERM "${BACKEND_PID}" 2>/dev/null || true
    log "==> Stopped backend server (PID ${BACKEND_PID})"
  fi
  rm -f "${BACKEND_PID_FILE}"
fi

pkill -f "node ${ROOT_DIR}/server.js" 2>/dev/null || sudo -n pkill -f "node ${ROOT_DIR}/server.js" 2>/dev/null || true

# 3. Free PUBLIC_PORT (:27715) and BACKEND_PORT (:17156) from any stale processes
for port in "${PUBLIC_PORT}" "${BACKEND_PORT}" 8080 8787; do
  port_pids="$(
    {
      lsof -ti tcp:"${port}" -sTCP:LISTEN 2>/dev/null || true
      sudo -n lsof -ti tcp:"${port}" -sTCP:LISTEN 2>/dev/null || true
      ss -lptn "sport = :${port}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 || true
      sudo -n ss -lptn "sport = :${port}" 2>/dev/null | grep -oE 'pid=[0-9]+' | cut -d= -f2 || true
    } | sort -u
  )"
  for pid in ${port_pids}; do
    if [[ -n "${pid}" && "${pid}" != "$$" && "${pid}" != "${PPID}" ]]; then
      unit="$(ps -o unit= -p "${pid}" 2>/dev/null | awk '{print $1}' || true)"
      if [[ -n "${unit}" && "${unit}" == *.service && "${unit}" != "ssh.service" && "${unit}" != "sshd.service" && "${unit}" != "user@"* && "${unit}" != "session-"* ]]; then
        sudo -n systemctl stop "${unit}" 2>/dev/null || true
      fi
      kill -9 "${pid}" 2>/dev/null || sudo -n kill -9 "${pid}" 2>/dev/null || true
    fi
  done
done

# 4. Stop any active Cloudflare workerd worker processes
pkill -f "workerd serve ${RUNTIME_DIR}" 2>/dev/null || sudo -n pkill -f "workerd serve ${RUNTIME_DIR}" 2>/dev/null || true

# 5. Stop any cloudflared tunnel connector
pkill -f "cloudflared tunnel" 2>/dev/null || sudo -n pkill -f "cloudflared tunnel" 2>/dev/null || true

log "==> All services stopped."
log "==> Local storage preserved at: ${STORAGE_DIR}/workers (all worker files & settings kept intact)."
