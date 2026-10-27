#!/usr/bin/env bash
# Stop Alex-Aero, and only Alex-Aero. Same as `bin/ax down`:  ./kill.sh [--quiet]
exec "$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/bin/ax" down "$@"
