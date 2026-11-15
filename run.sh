#!/usr/bin/env bash
# Start the Gatekeeper agent in the foreground (used by supervise.sh,
# systemd, and Docker). Reads config from .env (mode 600).
set -euo pipefail
cd "$(dirname "$0")"
exec node server.js
