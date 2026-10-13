#!/usr/bin/env bash
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STORAGE_DIR="${ROOT_DIR}/storage"
RUNTIME_DIR="${STORAGE_DIR}/runtime"
WORKERS_DIR="${STORAGE_DIR}/workers"
NGINX_DIR="${ROOT_DIR}/nginx"
CONFIG_FILE="${STORAGE_DIR}/config.json"
AUTH_FILE="${STORAGE_DIR}/auth.json"
BACKEND_PID_FILE="${RUNTIME_DIR}/backend.pid"
NGINX_PID_FILE="${RUNTIME_DIR}/nginx.pid"
BACKEND_LOG_FILE="${RUNTIME_DIR}/backend.log"

BACKEND_PORT="${BACKEND_PORT:-17156}"
PUBLIC_PORT="${PUBLIC_PORT:-27715}"

mkdir -p "${STORAGE_DIR}" "${RUNTIME_DIR}" "${WORKERS_DIR}" "${NGINX_DIR}"
rm -f "${RUNTIME_DIR}/network-ip.json" 2>/dev/null || true
chmod +x "${ROOT_DIR}/run.sh" "${ROOT_DIR}/kill.sh" "${ROOT_DIR}/server.js" 2>/dev/null || true

detect_local_ip() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  if [[ -z "${ip}" ]]; then
    ip="127.0.0.1"
  fi
  echo "${ip}"
}

ensure_dependencies() {
  # 1. Ensure nginx is installed and delete default nginx site/welcome files
  if ! command -v nginx >/dev/null 2>&1; then
    echo "==> Installing nginx reverse proxy..."
    sudo apt-get update -qq >/dev/null 2>&1 || true
    sudo apt-get install -y -qq nginx dnsutils curl psmisc lsof >/dev/null 2>&1 || true
  fi
  sudo -n systemctl stop nginx 2>/dev/null || sudo -n service nginx stop 2>/dev/null || true
  sudo -n rm -f /etc/nginx/sites-enabled/default /etc/nginx/sites-available/default /etc/nginx/conf.d/default.conf /var/www/html/index.nginx-debian.html /var/www/html/index.html 2>/dev/null || true

  # 2. Ensure Cloudflare workerd is installed (with local fallback for Raspberry Pi / non-root)
  if [[ -x "${ROOT_DIR}/.workerd-local/node_modules/.bin/workerd" ]]; then
    export PATH="${ROOT_DIR}/.workerd-local/node_modules/.bin:${PATH}"
  fi
  if ! command -v workerd >/dev/null 2>&1; then
    echo "==> Installing Cloudflare workerd runtime..."
    sudo npm install -g workerd >/dev/null 2>&1 ||
      npm install --prefix "${ROOT_DIR}/.workerd-local" workerd >/dev/null 2>&1 || true
    if [[ -x "${ROOT_DIR}/.workerd-local/node_modules/.bin/workerd" ]]; then
      export PATH="${ROOT_DIR}/.workerd-local/node_modules/.bin:${PATH}"
    fi
  fi

  # 3. Ensure cloudflared connector is installed (supports x86_64 and Raspberry Pi arm64/armhf)
  if ! command -v cloudflared >/dev/null 2>&1; then
    local arch
    arch="$(uname -m)"
    local cf_bin="cloudflared-linux-amd64"
    if [[ "${arch}" == "aarch64" || "${arch}" == "arm64" ]]; then
      cf_bin="cloudflared-linux-arm64"
    elif [[ "${arch}" == arm* ]]; then
      cf_bin="cloudflared-linux-arm"
    fi
    echo "==> Installing cloudflared (${cf_bin})..."
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/${cf_bin}" -o /tmp/cloudflared &&
      chmod +x /tmp/cloudflared &&
      sudo mv /tmp/cloudflared /usr/local/bin/cloudflared 2>/dev/null || true
  fi
}

save_auth_credentials() {
  local user="$1"
  local pass="$2"
  node -e '
    const fs = require("fs");
    const crypto = require("crypto");
    const authFile = process.argv[1];
    const cfgFile = process.argv[2];
    const username = process.argv[3] || "admin";
    const password = process.argv[4] || "";
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = crypto.scryptSync(password, salt, 64).toString("hex");
    fs.writeFileSync(
      authFile,
      JSON.stringify(
        {
          authEnabled: true,
          username,
          salt,
          passwordHash,
          updatedAt: new Date().toISOString()
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    if (fs.existsSync(cfgFile)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
        cfg.username = username;
        fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
      } catch (_) {}
    }
  ' "${AUTH_FILE}" "${CONFIG_FILE}" "${user}" "${pass}"
}

prompt_credentials() {
  if [[ -n "${ROBO_USERNAME:-}" && -n "${ROBO_PASSWORD:-}" ]]; then
    save_auth_credentials "${ROBO_USERNAME}" "${ROBO_PASSWORD}"
    echo "==> Saved credentials for '${ROBO_USERNAME}'."
    return 0
  fi

  if [[ ! -t 0 ]]; then
    return 0
  fi

  local default_user="admin"
  if [[ -f "${AUTH_FILE}" ]]; then
    local saved_u
    saved_u="$(node -e 'try{const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(a.username||"admin")}catch(_){console.log("admin")}' "${AUTH_FILE}" 2>/dev/null || echo "admin")"
    default_user="${saved_u:-admin}"
  fi

  echo "=== Alex-Aero (ax.) Sign-In Setup ==="
  read -r -p "Create username [${default_user}]: " mgmt_user || true
  mgmt_user="${mgmt_user:-${default_user}}"

  local mgmt_pass=""
  local mgmt_pass_confirm=""
  while true; do
    if [[ -f "${AUTH_FILE}" ]]; then
      read -r -s -p "Create password (or press Enter to keep existing password): " mgmt_pass || true
      echo ""
      if [[ -z "${mgmt_pass}" ]]; then
        node -e '
          const fs = require("fs");
          const a = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
          a.username = process.argv[2];
          a.authEnabled = true;
          fs.writeFileSync(process.argv[1], JSON.stringify(a, null, 2));
        ' "${AUTH_FILE}" "${mgmt_user}" 2>/dev/null || true
        echo "==> Sign-in active for username '${mgmt_user}'."
        echo ""
        return 0
      fi
    else
      read -r -s -p "Create password: " mgmt_pass || true
      echo ""
      if [[ -z "${mgmt_pass}" ]]; then
        echo "Password cannot be empty. Please enter a password."
        continue
      fi
    fi

    read -r -s -p "Confirm password: " mgmt_pass_confirm || true
    echo ""
    if [[ "${mgmt_pass}" != "${mgmt_pass_confirm}" ]]; then
      echo "Passwords do not match. Please try again."
      continue
    fi
    break
  done

  save_auth_credentials "${mgmt_user}" "${mgmt_pass}"
  echo "==> Sign-in credentials saved for '${mgmt_user}'."
  echo ""
}

run_interactive_setup() {
  echo "Platform setup/reset"
  echo ""
  echo "This clears the old username/password, IP details, domain details,"
  echo "tunnel state, DNS check state, logs, and temporary runtime state."
  echo "Existing worker projects, worker code, statistics, and shell scripts"
  echo "are preserved."
  echo ""

  local default_ip
  default_ip="$(detect_local_ip)"

  rm -f "${AUTH_FILE}"
  prompt_credentials

  local mgmt_user
  mgmt_user="$(node -e 'try{const a=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(a.username||"admin")}catch(_){console.log("admin")}' "${AUTH_FILE}" 2>/dev/null || echo "admin")"

  read -r -p "Cloudflare subdomain (example: panel or app.panel) []: " cf_sub || true
  read -r -p "Cloudflare root domain (example: example.com) []: " cf_domain || true
  read -r -p "Raspberry Pi local IP [${default_ip}]: " pi_ip || true
  pi_ip="${pi_ip:-${default_ip}}"

  read -r -p "Local network CIDR(s), comma-separated [10.0.0.0/8,172.16.0.0/12,192.168.0.0/16]: " net_cidrs || true
  net_cidrs="${net_cidrs:-10.0.0.0/8,172.16.0.0/12,192.168.0.0/16}"

  echo ""
  echo "Cloudflare Tunnel setup"
  echo "1. Open Cloudflare Zero Trust -> Networks -> Tunnels."
  echo "2. Create or select a Cloudflared tunnel."
  echo "3. Copy the tunnel token or install command if you want this script to run the connector."
  echo "4. Copy the Tunnel UUID so this platform can show the exact CNAME target (<tunnel-id>.cfargotunnel.com)."
  echo "5. In the tunnel Public Hostname tab, point your chosen hostname to http://localhost:${PUBLIC_PORT} (or http://${pi_ip}:${PUBLIC_PORT})."
  read -r -p "Cloudflare Tunnel ID (UUID, optional but needed for exact CNAME guidance): " cf_tunnel_id || true
  read -r -p "Cloudflare Tunnel token or full cloudflared service install command (optional): " cf_tunnel_token || true

  rm -f "${RUNTIME_DIR}/backend.log" "${RUNTIME_DIR}/nginx-access.log" "${RUNTIME_DIR}/nginx-error.log"

  cat <<EOF > "${CONFIG_FILE}"
{
  "username": "${mgmt_user}",
  "subdomain": "${cf_sub}",
  "rootDomain": "${cf_domain}",
  "localIp": "${pi_ip}",
  "networkCidrs": "${net_cidrs}",
  "tunnelId": "${cf_tunnel_id}",
  "tunnelToken": "${cf_tunnel_token}",
  "dnsRecordStatus": "unchecked",
  "dnsLastChecked": null,
  "dnsCheckMessage": "No custom domain configured yet.",
  "UpdatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
}

generate_nginx_config() {
  local nginx_tmp_base="/tmp/robo-workers-nginx"
  rm -rf "${RUNTIME_DIR}/nginx-body" "${RUNTIME_DIR}/nginx-proxy" "${RUNTIME_DIR}/nginx-fastcgi" "${RUNTIME_DIR}/nginx-uwsgi" "${RUNTIME_DIR}/nginx-scgi" 2>/dev/null ||
    sudo -n rm -rf "${RUNTIME_DIR}/nginx-body" "${RUNTIME_DIR}/nginx-proxy" "${RUNTIME_DIR}/nginx-fastcgi" "${RUNTIME_DIR}/nginx-uwsgi" "${RUNTIME_DIR}/nginx-scgi" 2>/dev/null || true
  mkdir -p "${nginx_tmp_base}/body" "${nginx_tmp_base}/proxy" "${nginx_tmp_base}/fastcgi" "${nginx_tmp_base}/uwsgi" "${nginx_tmp_base}/scgi" 2>/dev/null ||
    sudo -n mkdir -p "${nginx_tmp_base}/body" "${nginx_tmp_base}/proxy" "${nginx_tmp_base}/fastcgi" "${nginx_tmp_base}/uwsgi" "${nginx_tmp_base}/scgi" 2>/dev/null || true
  chmod -R 1777 "${nginx_tmp_base}" 2>/dev/null || sudo -n chmod -R 1777 "${nginx_tmp_base}" 2>/dev/null || true
  touch "${RUNTIME_DIR}/nginx-error.log" "${RUNTIME_DIR}/nginx-access.log" 2>/dev/null || true
  chmod 666 "${RUNTIME_DIR}/nginx-error.log" "${RUNTIME_DIR}/nginx-access.log" 2>/dev/null || true

  cat <<EOF > "${NGINX_DIR}/nginx.conf"
user root;
worker_processes auto;
pid ${NGINX_PID_FILE};
error_log ${RUNTIME_DIR}/nginx-error.log notice;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    access_log ${RUNTIME_DIR}/nginx-access.log;
    client_body_temp_path ${nginx_tmp_base}/body;
    proxy_temp_path ${nginx_tmp_base}/proxy;
    fastcgi_temp_path ${nginx_tmp_base}/fastcgi;
    uwsgi_temp_path ${nginx_tmp_base}/uwsgi;
    scgi_temp_path ${nginx_tmp_base}/scgi;

    client_max_body_size 64m;
    client_body_buffer_size 16m;
    proxy_buffer_size 128k;
    proxy_buffers 16 128k;
    proxy_busy_buffers_size 256k;

    sendfile on;
    keepalive_timeout 65;
    server_tokens off;
    proxy_buffering off;
    proxy_request_buffering off;

    # Preserve real user IP from Cloudflare / upstream proxies instead of Raspberry Pi's own IP
    map \$http_x_forwarded_for \$first_forwarded_ip {
        ~^([^,\\s]+) \$1;
        default      \$remote_addr;
    }

    map \$http_x_real_ip \$fallback_real_ip {
        ""      \$first_forwarded_ip;
        default \$http_x_real_ip;
    }

    map \$http_x_client_ip \$fallback_client_ip {
        ""      \$fallback_real_ip;
        default \$http_x_client_ip;
    }

    map \$http_true_client_ip \$fallback_true_ip {
        ""      \$fallback_client_ip;
        default \$http_true_client_ip;
    }

    map \$http_cf_connecting_ip \$true_client_ip {
        ""      \$fallback_true_ip;
        default \$http_cf_connecting_ip;
    }

    server {
        listen 0.0.0.0:${PUBLIC_PORT} default_server;
        listen [::]:${PUBLIC_PORT} default_server;
        server_name _;

        # Allow native browser renderer in preview iframes & direct visits
        proxy_hide_header X-Frame-Options;
        proxy_hide_header Content-Security-Policy;
        proxy_pass_header WWW-Authenticate;

        location / {
            proxy_pass http://127.0.0.1:${BACKEND_PORT};
            proxy_http_version 1.1;

            proxy_set_header Host \$http_host;
            proxy_set_header Authorization \$http_authorization;
            proxy_set_header X-Real-IP \$true_client_ip;
            proxy_set_header X-Client-IP \$true_client_ip;
            proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_set_header X-Forwarded-Host \$http_host;
            proxy_set_header CF-Connecting-IP \$true_client_ip;
            proxy_set_header User-Agent \$http_user_agent;
            proxy_set_header Accept-Language \$http_accept_language;
            proxy_set_header Accept \$http_accept;
            proxy_set_header Origin \$http_origin;
            proxy_set_header Upgrade \$http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }
}
EOF
}

if [[ "${1:-}" == "setup" || "${1:-}" == "reset" || "${1:-}" == "setup/reset" ]]; then
  run_interactive_setup
  shift
else
  prompt_credentials
fi

ensure_dependencies

bash "${ROOT_DIR}/kill.sh" --quiet >/dev/null 2>&1 || true

generate_nginx_config

NODE_VER="$(node -v 2>/dev/null || echo 'unknown')"
PY_VER="$(python3 --version 2>/dev/null | awk '{print $2}' || echo 'unknown')"
WORKERD_VER="$(workerd --version 2>/dev/null | awk '{print $2}' || echo 'installed')"
LOCAL_IP="$(detect_local_ip)"

echo "==> workerd runtime starting"
echo "==> runtimes: node ${NODE_VER}, python ${PY_VER}, workerd ${WORKERD_VER}"

# Start Nginx reverse proxy on 0.0.0.0:8080 and Backend controller on 127.0.0.1:8787
nginx -c "${NGINX_DIR}/nginx.conf" -e "${RUNTIME_DIR}/nginx-error.log" 2>/dev/null ||
  sudo -n nginx -c "${NGINX_DIR}/nginx.conf" -e "${RUNTIME_DIR}/nginx-error.log"

echo "==> starting backend (:${BACKEND_PORT})"
nohup node "${ROOT_DIR}/server.js" > "${BACKEND_LOG_FILE}" 2>&1 &
BACKEND_PID=$!
echo "${BACKEND_PID}" > "${BACKEND_PID_FILE}"

# Wait for backend (:8787) to start listening
for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:${BACKEND_PORT}/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

echo "==> nginx listening (:${PUBLIC_PORT})"
echo "==> dashboard: http://${LOCAL_IP}:${PUBLIC_PORT}/ (or http://localhost:${PUBLIC_PORT}/)  (workers: http://${LOCAL_IP}:${PUBLIC_PORT}/<WorkerName>)"
echo ""
echo "Setup complete."
echo "Dashboard: http://${LOCAL_IP}:${PUBLIC_PORT}/"
echo "Workers: http://${LOCAL_IP}:${PUBLIC_PORT}/<WorkerName>"

if [[ "${1:-}" == "--foreground" ]]; then
  trap 'bash "${ROOT_DIR}/kill.sh" --quiet; exit 0' SIGINT SIGTERM EXIT
  while kill -0 "${BACKEND_PID}" 2>/dev/null; do
    sleep 2
  done
fi
