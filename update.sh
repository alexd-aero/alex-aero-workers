#!/usr/bin/env bash
# Brings any Alex-Aero install up to date, the updater included, in one go:
#
#   curl -fsSL https://raw.githubusercontent.com/alexd-aero/alex-aero-workers/master/update.sh | bash
#   curl -fsSL …/update.sh | bash -s -- /path/to/alex-aero      (when it can't find it by itself)
#
# It finds the install (the folder given, this folder, where `ax` points, the
# one running, or the usual places), puts the newest bin/ax in it, and runs
# `ax update`: workers, settings, the login and logs are kept, the code before
# is saved in storage/backups/, and it restarts only if it was running.
set -uo pipefail
REPO="${AX_UPDATE_REPO:-alexd-aero/alex-aero-workers}"
BRANCH="${AX_UPDATE_BRANCH:-master}"

say() { printf '  · %s\n' "$*"; }
die() { printf '  ✘ %s\n' "$*" >&2; exit 1; }
is_install() { [ -n "$1" ] && [ -f "$1/server.js" ] && grep -q '"name": *"alex-aero"' "$1/package.json" 2>/dev/null; }

find_install() {
  local c p
  for c in "${1:-}" "$PWD" "$(dirname "$(dirname "$(readlink -f "$HOME/.local/bin/ax" 2>/dev/null || echo /x/x/x)")")"; do
    is_install "$c" && { echo "$c"; return 0; }
  done
  # the one running: node …/server.js
  for p in $(pgrep -f '[n]ode .*/server.js' 2>/dev/null); do
    c="$(tr '\0' '\n' <"/proc/$p/cmdline" 2>/dev/null | grep '/server.js$' | head -1)"
    c="$(dirname "$c" 2>/dev/null)"
    is_install "$c" && { echo "$c"; return 0; }
  done
  for c in "$HOME/alex-aero" "$HOME/alex-aero-workers" "$HOME"/*/alex-aero "$HOME"/*/alex-aero-workers /opt/alex-aero /srv/alex-aero; do
    is_install "$c" && { echo "$c"; return 0; }
  done
  return 1
}

printf '\n  Alex-Aero update\n\n'
command -v curl >/dev/null 2>&1 || die "curl is needed"
command -v tar >/dev/null 2>&1 || die "tar is needed"
DIR="$(find_install "${1:-}")" || die "couldn't find Alex-Aero here. Give its folder: curl -fsSL …/update.sh | bash -s -- /path/to/alex-aero"
[ -w "$DIR" ] || die "$DIR isn't writable by $(id -un): run this as the user who owns it"
say "found it in $DIR ($(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$DIR/package.json" | head -1))"

# the newest ax first: older installs don't have `ax update` yet
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
say "downloading the newest version from github.com/$REPO"
# the branch's newest commit (GitHub's API): branch downloads are cached for minutes, a commit's never go stale
ref="$(curl -fsSL -m 15 -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/$BRANCH" 2>/dev/null)"
[[ "$ref" =~ ^[0-9a-f]{40}$ ]] || ref="refs/heads/$BRANCH"
curl -fsSL -m 300 "https://codeload.github.com/$REPO/tar.gz/$ref" -o "$tmp/src.tgz" || die "the download from GitHub failed"
tar -xzf "$tmp/src.tgz" -C "$tmp" --strip-components=1 || die "the download isn't a readable archive"
[ -f "$tmp/bin/ax" ] && [ -f "$tmp/bin/ui.sh" ] || die "the download doesn't look like Alex-Aero"
for f in ax ui.sh; do
  cp "$tmp/bin/$f" "$DIR/bin/$f.new" && mv "$DIR/bin/$f.new" "$DIR/bin/$f" || die "couldn't write $DIR/bin/$f"
done
chmod +x "$DIR/bin/ax" "$DIR"/*.sh 2>/dev/null

# then the update itself (--force: GitHub's raw copy can lag a few minutes behind a release)
cd "$DIR" || exit 1
AX_NONINTERACTIVE=1 bash "$DIR/bin/ax" update --yes --force </dev/null
