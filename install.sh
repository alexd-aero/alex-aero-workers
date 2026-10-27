#!/usr/bin/env bash
# Alex·Aero installer. Run it from a checkout:
#
#   ./install.sh                 native install (Linux or macOS), then start it
#   ./install.sh --docker        build and run the Docker image instead
#   ./install.sh --port 8080     serve the dashboard on another port
#   ./install.sh --no-start      install only
#
# Native installs keep everything inside this folder: a private Node.js in .node/
# when the machine has none (or one older than 18.17), workerd in .workerd-local/,
# cloudflared in .bin/. Nothing is installed system-wide except an `ax` link in
# ~/.local/bin.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=bin/ui.sh
. "$DIR/bin/ui.sh"
trap 'spin_stop; printf "%s" "$SHOW"' EXIT

MODE=native
START=1
PORT="${PUBLIC_PORT:-27715}"
while [ $# -gt 0 ]; do
  case "$1" in
    --docker) MODE=docker ;;
    --no-start) START=0 ;;
    --port) PORT="${2:?--port needs a number}"; shift ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
  shift
done

VERSION="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/package.json" | head -1)"
banner "$VERSION"

# ------------------------------------------------------------------ docker
if [ "$MODE" = docker ]; then
  command -v docker >/dev/null 2>&1 || die "Docker isn't installed: https://docs.docker.com/get-docker/"
  title "Docker install"
  if [ ! -f "$DIR/.env" ]; then
    pass=""
    if interactive; then
      say "Pick the dashboard login (username: admin)."
      while :; do
        pass="$(ask_secret "Password")" || true
        [ ${#pass} -ge 8 ] && break
        warn "at least 8 characters"
      done
    else
      pass="$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
      info "generated a password: ${B}$pass${NC} (it's in .env)"
    fi
    printf 'AX_ADMIN_USER=admin\nAX_ADMIN_PASSWORD=%s\nAX_PORT=%s\nTZ=%s\n' "$pass" "$PORT" "${TZ:-$(cat /etc/timezone 2>/dev/null || echo UTC)}" >"$DIR/.env"
    chmod 600 "$DIR/.env"
    ok "wrote .env"
  fi
  spin_start "building the image (first time takes a few minutes)"
  if (cd "$DIR" && docker compose build >/tmp/alex-aero-build.log 2>&1); then spin_stop; ok "image built"
  else spin_stop; tail -20 /tmp/alex-aero-build.log; die "build failed (full log: /tmp/alex-aero-build.log)"; fi
  (cd "$DIR" && docker compose up -d) >/dev/null
  ok "running: ${B}docker compose ps${NC} · logs: ${B}docker compose logs -f${NC}"
  printf '\n'; linkline open "http://localhost:$PORT/"; printf '\n'
  exit 0
fi

# ------------------------------------------------------------------ native
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS" in Linux|Darwin) ;; *) die "native installs support Linux and macOS; on Windows use: ./install.sh --docker (Docker Desktop or WSL)" ;; esac
title "Native install" "$OS $ARCH · $DIR"

ver_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }
node_ok() { [ -x "$1" ] && ver_ge "$("$1" -v 2>/dev/null | tr -d v)" 18.17.0; }

NODE=""
for n in "$DIR/.node/bin/node" "$(command -v node 2>/dev/null || true)" $(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -rV); do
  if [ -n "$n" ] && node_ok "$n"; then NODE="$n"; break; fi
done
if [ -n "$NODE" ]; then
  ok "Node.js $("$NODE" -v) ${DIM}$NODE${NC}"
else
  case "$OS-$ARCH" in
    Linux-x86_64) plat=linux-x64 ;; Linux-aarch64|Linux-arm64) plat=linux-arm64 ;; Linux-armv7l) plat=linux-armv7l ;;
    Darwin-x86_64) plat=darwin-x64 ;; Darwin-arm64) plat=darwin-arm64 ;;
    *) die "no Node.js build for $OS $ARCH; install Node 18.17+ yourself and rerun" ;;
  esac
  base="https://nodejs.org/dist/latest-v22.x"
  spin_start "downloading Node.js 22 ($plat)"
  file="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v p="$plat.tar.gz" '$2 ~ p"$" {print $2; exit}')"
  [ -n "$file" ] || { spin_stop; die "couldn't find a Node.js download for $plat"; }
  tmp="$(mktemp -d)"
  curl -fsSL "$base/$file" -o "$tmp/$file"
  want="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v f="$file" '$2 == f {print $1}')"
  got="$( (command -v sha256sum >/dev/null && sha256sum "$tmp/$file" || shasum -a 256 "$tmp/$file") | awk '{print $1}')"
  [ "$want" = "$got" ] || { spin_stop; die "Node.js download failed its checksum"; }
  rm -rf "$DIR/.node" && mkdir -p "$DIR/.node"
  tar -xzf "$tmp/$file" -C "$DIR/.node" --strip-components=1
  rm -rf "$tmp"
  spin_stop
  NODE="$DIR/.node/bin/node"
  ok "Node.js $("$NODE" -v) ${DIM}(private copy in .node/)${NC}"
fi
export PATH="$(dirname "$NODE"):$PATH"

if [ -x "$DIR/.workerd-local/node_modules/.bin/workerd" ]; then
  ok "workerd $("$DIR/.workerd-local/node_modules/.bin/workerd" --version 2>/dev/null | awk '{print $2}')"
else
  spin_start "installing workerd (Cloudflare's runtime)"
  if npm install --prefix "$DIR/.workerd-local" workerd --no-audit --no-fund >/tmp/alex-aero-npm.log 2>&1; then
    spin_stop; ok "workerd $("$DIR/.workerd-local/node_modules/.bin/workerd" --version 2>/dev/null | awk '{print $2}')"
  else
    spin_stop; warn "workerd isn't available for $OS $ARCH; JavaScript workers will run inside Node instead"
  fi
fi

command -v python3 >/dev/null 2>&1 && ok "$(python3 --version)" || warn "python3 not found: Python workers need it"
command -v nginx >/dev/null 2>&1 && ok "nginx found, it'll sit in front" || say "no nginx: Node serves the port directly (that's fine)"

mkdir -p "$HOME/.local/bin"
ln -sf "$DIR/bin/ax" "$HOME/.local/bin/ax"
chmod +x "$DIR/bin/ax" "$DIR/run.sh" "$DIR/kill.sh" 2>/dev/null || true
ok "linked ${B}ax${NC} into ~/.local/bin"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) warn "add ~/.local/bin to your PATH to type ${B}ax${NC} anywhere" ;; esac

[ "$START" = 1 ] || { printf '\n'; say "start it with: ${B}ax up${NC}"; exit 0; }
printf '\n'
PUBLIC_PORT="$PORT" AX_NODE="$NODE" "$DIR/bin/ax" up
if command -v systemctl >/dev/null 2>&1 && interactive && confirm "Start Alex·Aero at boot and restart it if it crashes?" y; then
  PUBLIC_PORT="$PORT" AX_NODE="$NODE" "$DIR/bin/ax" autostart on
fi
