#!/usr/bin/env bash
# Start Alex-Aero. Same as `bin/ax up`:  ./run.sh · ./run.sh setup · ./run.sh --foreground
# The full CLI is bin/ax (run it with no arguments for the menu).
exec "$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)/bin/ax" up "$@"
