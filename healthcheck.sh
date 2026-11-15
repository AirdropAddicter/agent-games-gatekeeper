#!/usr/bin/env bash
# Health check for the Gatekeeper agent (+ tunnel, when up).
# Designed to run from cron every 5 minutes (the parent agent wires the
# schedule) or manually. It never starts anything itself — it only kills
# a HUNG agent so the supervisor restarts it, and logs tunnel status.
#
#   */5 * * * *  /home/hatch/workspace/agent-games/gatekeeper/healthcheck.sh
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/logs"
LOG="$ROOT/logs/healthcheck.log"
load_env() { set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a; }
load_env
PORT="${PORT:-8788}"

say() { echo "$(date -Iseconds) $*" | tee -a "$LOG"; }

if curl -fsS -m 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  say "OK local agent http://127.0.0.1:${PORT}/health"
else
  say "FAIL local agent not responding on :${PORT}"
  if [ -f "$ROOT/run/agent.pid" ] && kill -0 "$(cat "$ROOT/run/agent.pid")" 2>/dev/null; then
    say "killing hung agent pid $(cat "$ROOT/run/agent.pid") (supervisor will restart it)"
    kill "$(cat "$ROOT/run/agent.pid")" 2>/dev/null || true
  else
    say "agent pid file missing/not running — supervisor should have restarted it; check logs/supervisor.log"
  fi
fi

if [ -f "$ROOT/data/public-url.txt" ]; then
  url="$(cat "$ROOT/data/public-url.txt")"
  if curl -fsS -m 10 "${url}/health" >/dev/null 2>&1; then
    say "OK public tunnel ${url}/health"
  else
    say "FAIL public tunnel ${url}/health not responding (tunnel may have rotated; check logs/ngrok.log)"
  fi
else
  say "INFO no public URL file — tunnel not up (needs NGROK_AUTHTOKEN in .env)"
fi
