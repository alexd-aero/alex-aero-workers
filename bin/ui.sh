# bin/ui.sh: how bin/ax looks and asks. Sourced, never run.
# The same terminal language as Aegis × Burrow and Selkies Forge: a gradient
# banner, ✔ · ! ✘ lines, a spinner, a status panel, arrow-key menus, and prompts
# that read the keyboard even under `curl … | bash`.
# Safe under `set -uo pipefail`: no helper returns non-zero by accident.

# ---------------------------------------------------------------- colours
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then
  COLOR=1
  NC=$'\033[0m'; B=$'\033[1m'; DIM=$'\033[2m'
  RED=$'\033[38;5;203m'; GRN=$'\033[38;5;79m'; YEL=$'\033[38;5;221m'
  SKY=$'\033[38;5;117m'; VIO=$'\033[38;5;141m'; GRY=$'\033[38;5;245m'; WHT=$'\033[38;5;255m'
  HIDE=$'\033[?25l'; SHOW=$'\033[?25h'; CLRL=$'\033[2K\r'
else
  COLOR=0
  NC=""; B=""; DIM=""; RED=""; GRN=""; YEL=""; SKY=""; VIO=""; GRY=""; WHT=""
  HIDE=""; SHOW=""; CLRL=$'\r'
fi
TRUECOLOR=0
case "${COLORTERM:-}" in truecolor|24bit) [ "$COLOR" = 1 ] && TRUECOLOR=1 ;; esac

# Where answers come from. Under `curl … | bash` stdin is the script itself,
# so questions read the keyboard through /dev/tty. Empty: no keyboard at all.
TTY_IN=""
if [ -t 0 ]; then TTY_IN="/dev/stdin"
elif ( : </dev/tty ) 2>/dev/null; then TTY_IN="/dev/tty"; fi
[ -n "${AX_NONINTERACTIVE:-}" ] && TTY_IN=""
interactive() { [ -n "$TTY_IN" ] && [ -t 1 ]; }

cols() { local c; c=$(tput cols 2>/dev/null || echo 80); [ "$c" -ge 20 ] 2>/dev/null || c=80; echo "$c"; }

# sky -> violet across a string
grad() {
  local text="$1" n i d r g b out=""
  n=${#text}
  if [ "$TRUECOLOR" != 1 ] || [ "$n" -eq 0 ]; then printf '%s' "${SKY}${text}${NC}"; return 0; fi
  d=$((n > 1 ? n - 1 : 1))
  for ((i = 0; i < n; i++)); do
    r=$((125 + 42 * i / d)); g=$((211 - 72 * i / d)); b=$((252 - 2 * i / d))
    out+=$'\033[38;2;'"${r};${g};${b}m${text:i:1}"
  done
  printf '%s%s' "$out" "$NC"
}

say()  { printf '  %s·%s %s\n' "$GRY" "$NC" "$*"; }
info() { printf '  %s·%s %s\n' "$SKY" "$NC" "$*"; }
ok()   { printf '  %s✔%s %s\n' "$GRN" "$NC" "$*"; }
warn() { printf '  %s!%s %s\n' "$YEL" "$NC" "$*" >&2; }
bad()  { printf '  %s✘%s %s\n' "$RED" "$NC" "$*" >&2; }
die()  { spin_stop; printf '  %s✘ %s%s\n' "$RED" "$*" "$NC" >&2; exit 1; }
dim()  { printf '  %s%s%s\n' "$DIM" "$*" "$NC"; }

rule() {
  local w c; w=$(cols); c=$((w - 4))
  [ "$c" -gt 68 ] && c=68
  [ "$c" -lt 10 ] && c=10
  printf '  %s' "$DIM"; printf '─%.0s' $(seq 1 "$c"); printf '%s\n' "$NC"
}
title() {
  printf '\n  %s%s%s\n' "$B$WHT" "$1" "$NC"
  if [ $# -gt 1 ]; then printf '  %s%s%s\n' "$DIM" "$2" "$NC"; fi
  rule
}
# a link worth copying, on a line of its own
linkline() { printf '    %s%-8s%s %s%s%s\n' "$DIM" "$1" "$NC" "$B$SKY" "$2" "$NC"; }
# one row of the status panel: row STATE NAME DETAIL   (STATE: up|down|off|warn)
row() {
  local dot
  case "$1" in
    up)   dot="${GRN}●${NC}" ;;
    down) dot="${RED}●${NC}" ;;
    warn) dot="${YEL}●${NC}" ;;
    *)    dot="${DIM}○${NC}" ;;
  esac
  printf '  %s %s%-11s%s %s\n' "$dot" "$B" "$2" "$NC" "$3"
}

# ------------------------------------------------------------------ banner
banner() {
  local v="${1:-}" w; w=$(cols)
  printf '\n'
  if [ "$w" -lt 52 ]; then
    printf '  %s  %s\n' "$(grad '◆ ALEX-AERO')" "${DIM}${v:+v$v}$NC"
    printf '  %sworkers on your own box%s\n\n' "$DIM" "$NC"
    return 0
  fi
  printf '  %s\n' "$(grad ' █████  ██   ██')"
  printf '  %s\n' "$(grad '██   ██  ██ ██ ')"
  printf '  %s\n' "$(grad '███████   ███  ')"
  printf '  %s\n' "$(grad '██   ██  ██ ██ ')"
  printf '  %s %s●%s\n' "$(grad '██   ██ ██   ██')" "$VIO" "$NC"
  printf '  %s%s%s  %sA L E X - A E R O%s  %s%s· workers on your own box%s\n\n' \
    "$DIM" "────" "$NC" "$B$VIO" "$NC" "$DIM" "${v:+v$v }" "$NC"
}

# ----------------------------------------------------------------- spinner
SPIN_PID=""
spin_start() {
  if [ ! -t 1 ]; then printf '  · %s…\n' "$1"; return 0; fi
  local msg="$1"
  printf '%s' "$HIDE"
  ( local frames='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏' i=0
    while :; do
      i=$(((i + 1) % 10))
      printf '%s  %s%s%s %s' "$CLRL" "$SKY" "${frames:i:1}" "$NC" "$msg"
      sleep 0.08
    done ) &
  SPIN_PID=$!
}
spin_stop() {
  if [ -n "${SPIN_PID:-}" ]; then
    kill "$SPIN_PID" 2>/dev/null || true
    wait "$SPIN_PID" 2>/dev/null || true
    SPIN_PID=""
    printf '%s%s' "$CLRL" "$SHOW"
  fi
  return 0
}

# ------------------------------------------------------------------ prompts
ask() {  # ask PROMPT [DEFAULT] -> stdout
  local p="$1" d="${2:-}" r=""
  if [ -z "$TTY_IN" ]; then printf '%s' "$d"; return 0; fi
  if [ -n "$d" ]; then printf '  %s%s%s %s[%s]%s ' "$B" "$p" "$NC" "$DIM" "$d" "$NC" >/dev/tty
  else printf '  %s%s%s ' "$B" "$p" "$NC" >/dev/tty; fi
  IFS= read -r r <"$TTY_IN" || true
  printf '%s' "${r:-$d}"
}
ask_secret() {  # ask_secret PROMPT -> stdout (never echoed)
  local r=""
  [ -n "$TTY_IN" ] || return 1
  printf '  %s%s%s ' "$B" "$1" "$NC" >/dev/tty
  IFS= read -rs r <"$TTY_IN" || true
  printf '\n' >/dev/tty
  printf '%s' "$r"
}
confirm() {  # confirm PROMPT [y|n]
  local p="$1" d="${2:-n}" r=""
  [ "${ASSUME_YES:-0}" = 1 ] && return 0
  if [ -z "$TTY_IN" ]; then [ "$d" = y ]; return $?; fi
  printf '  %s%s%s %s(%s)%s ' "$B" "$p" "$NC" "$DIM" "$([ "$d" = y ] && echo 'Y/n' || echo 'y/N')" "$NC" >/dev/tty
  IFS= read -r r <"$TTY_IN" || true
  case "${r:-$d}" in [yY]*) return 0 ;; *) return 1 ;; esac
}
pause() { [ -n "$TTY_IN" ] || return 0; printf '  %spress enter%s' "$DIM" "$NC" >/dev/tty; IFS= read -r _ <"$TTY_IN" || true; printf '\n'; }

# -------------------------------------------------------------- arrow menu
# menu_choose TITLE "value<TAB>label<TAB>hint"… -> the chosen value on stdout;
# returns 1 when cancelled (q, esc). Draws on the terminal, not stdout.
menu_choose() {
  local title="$1"; shift
  local -a items=("$@")
  local n=${#items[@]} UI="/dev/stderr"
  [ "$n" -gt 0 ] || return 1
  [ -w /dev/tty ] && UI="/dev/tty"
  if [ -z "$TTY_IN" ]; then return 1; fi
  local sel=0 top=0 page rows key key2 drawn=0 i lab hint
  rows=$(tput lines 2>/dev/null || echo 24)
  page=$((rows - 8)); [ "$page" -lt 5 ] && page=5; [ "$page" -gt 16 ] && page=16
  [ "$page" -gt "$n" ] && page=$n
  exec 9<"$TTY_IN"
  printf '%s' "$HIDE" >"$UI"
  while :; do
    if [ "$drawn" -gt 0 ]; then printf '\033[%dA' "$drawn" >"$UI"; fi
    drawn=0
    printf '%s  %s%s%s\n' "$CLRL" "$B$WHT" "$title" "$NC" >"$UI"; drawn=$((drawn + 1))
    printf '%s  %s↑↓ move · enter choose · q back%s\n' "$CLRL" "$DIM" "$NC" >"$UI"; drawn=$((drawn + 1))
    for ((i = top; i < top + page && i < n; i++)); do
      lab="${items[$i]#*$'\t'}"; hint="${lab#*$'\t'}"; lab="${lab%%$'\t'*}"
      [ "$hint" = "$lab" ] && hint=""
      if [ "$i" -eq "$sel" ]; then
        printf '%s  %s❯%s %s%-30.30s%s %s%s%s\n' "$CLRL" "$VIO" "$NC" "$B$WHT" "$lab" "$NC" "$SKY" "$hint" "$NC" >"$UI"
      else
        printf '%s    %-30.30s %s%s%s\n' "$CLRL" "$lab" "$DIM" "$hint" "$NC" >"$UI"
      fi
      drawn=$((drawn + 1))
    done
    printf '%s  %s%d of %d%s\n' "$CLRL" "$DIM" "$((sel + 1))" "$n" "$NC" >"$UI"; drawn=$((drawn + 1))
    key=""
    if ! IFS= read -rsn1 key <&9; then printf '%s' "$SHOW" >"$UI"; exec 9<&-; return 1; fi
    case "$key" in
      $'\x1b')
        key2=""; IFS= read -rsn2 -t 0.05 key2 <&9 || true
        case "$key2" in
          '[A') sel=$((sel > 0 ? sel - 1 : n - 1)) ;;
          '[B') sel=$((sel < n - 1 ? sel + 1 : 0)) ;;
          '[H') sel=0 ;;
          '[F') sel=$((n - 1)) ;;
          '') printf '%s' "$SHOW" >"$UI"; exec 9<&-; return 1 ;;
        esac ;;
      k) sel=$((sel > 0 ? sel - 1 : n - 1)) ;;
      j) sel=$((sel < n - 1 ? sel + 1 : 0)) ;;
      q|Q) printf '%s' "$SHOW" >"$UI"; exec 9<&-; return 1 ;;
      "") printf '%s' "$SHOW" >"$UI"; exec 9<&-
          printf '%s' "${items[$sel]%%$'\t'*}"; return 0 ;;
      [1-9]) if [ "$key" -le "$n" ]; then sel=$((key - 1)); fi ;;
    esac
    if [ "$sel" -lt "$top" ]; then top=$sel; fi
    if [ "$sel" -ge $((top + page)) ]; then top=$((sel - page + 1)); fi
  done
}
