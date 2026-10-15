#!/bin/sh
set -eu
exec node "$(dirname "$0")/build-telemetry.cjs" "$@"
