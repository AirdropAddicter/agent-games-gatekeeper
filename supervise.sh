#!/usr/bin/env bash
# Supervisor for the Gatekeeper agent (+ serveo SSH tunnel).
# No systemd user bus exists in this VM ("Failed to connect to bus"), so
# this script is the resilience layer: it restarts the agent and the
# tunnel whenever either exits, and logs everything.
#
# Usage:
#   ./supervise.sh start    # launch supervisor in background (nohup)
#   ./supervise.sh stop     # stop supervisor, agent, and tunnel
#   ./supervise.sh status   # show PIDs + public URL (if any)
#   ./supervise.sh restart  # stop, then start (use after editing .env)
#
# Tunnel: serveo.net over SSH through the VM egress proxy (see
# bin/proxy-connect.sh). zrok/ngrok/cloudflared all fail on this VM:
# zrok's OpenZiti data plane dials edge routers directly (no proxy
# support wired into zrok2, no iptables to redirect); ngrok free
# refuses to run behind a proxy; cloudflared ignores the proxy env.
# Serveo gives a public https URL; with SERVEVO_SUBDOMAIN set in .env
# (after registering the SSH key at console.serveo.net) the subdomain
# is stable across restarts, otherwise serveo assigns a random one.
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$ROOT/logs" "$ROOT/run" "$ROOT/data"
SUP_PID_FILE="$ROOT/run/supervisor.pid"
AGENT_PID_FILE="$ROOT/run/agent.pid"
TUNNEL_PID_FILE="$ROOT/run/serveo.pid"
PUBLIC_URL_FILE="$ROOT/data/public-url.txt"

load_env() {
  # shellcheck disable=SC1091
  set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
}

agent_loop() {
  while true; do
    load_env
    PORT="${PORT:-8788}" HOST="${HOST:-127.0.0.1}" node "$ROOT/server.js" >>"$ROOT/logs/agent.log" 2>&1 &
    echo $! > "$AGENT_PID_FILE"
    wait $! || true
    echo "$(date -Iseconds) agent exited; restarting in 5s" >>"$ROOT/logs/supervisor.log"
    sleep 5
  done
}

publish_public_url() {
  # Poll the serveo log until the forwarding URL appears, then record it.
  # Stops early if the ssh process died (tunnel_loop restarts it).
  local ssh_pid="$1"
  for _ in $(seq 1 30); do
    kill -0 "$ssh_pid" 2>/dev/null || return 1
    url=$(sed 's/\x1b\[[0-9;]*m//g' "$ROOT/logs/serveo.log" 2>/dev/null | tr -d '\r' \
      | grep 'Forwarding HTTP traffic from' | grep -o 'https://[^ ]*' | head -1 || true)
    if [ -n "${url:-}" ]; then
      echo "$url" > "$PUBLIC_URL_FILE"
      echo "$(date -Iseconds) public URL: $url" >>"$ROOT/logs/supervisor.log"
      return 0
    fi
    sleep 2
  done
  echo "$(date -Iseconds) WARNING: serveo started but no public URL appeared" >>"$ROOT/logs/supervisor.log"
  return 1
}

tunnel_loop() {
  load_env
  local port="${PORT:-8788}"
  local remote="80:localhost:$port"
  if [ -n "${SERVEVO_SUBDOMAIN:-}" ]; then
    remote="${SERVEVO_SUBDOMAIN}:80:localhost:$port"
  fi
  while true; do
    rm -f "$PUBLIC_URL_FILE"
    : > "$ROOT/logs/serveo.log"
    ssh -i "$ROOT/.ssh/serveo_key" \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
      -o ExitOnForwardFailure=yes \
      -o ProxyCommand="$ROOT/bin/proxy-connect.sh %h %p" \
      -R "$remote" serveo.net >>"$ROOT/logs/serveo.log" 2>&1 &
    echo $! > "$TUNNEL_PID_FILE"
    publish_public_url $! || true
    wait $! || true
    echo "$(date -Iseconds) serveo exited; restarting in 5s" >>"$ROOT/logs/supervisor.log"
    sleep 5
  done
}

supervisor_main() {
  echo $$ > "$SUP_PID_FILE"
  echo "$(date -Iseconds) supervisor started (pid $$)" >>"$ROOT/logs/supervisor.log"
  agent_loop &
  tunnel_loop &
  warm_loop &
  wait
}

warm_loop() {
  # Keep-warm + health-watch. Serveo can expire the port forwarding
  # while the SSH process stays alive (edge returns 502) — the tunnel
  # loop only restarts on ssh exit, so this loop detects a dead
  # tunnel and kills it (tunnel_loop brings up a fresh one). Hit the
  # public URL every 60s; after 2 consecutive failures (or an
  # "expired" line in serveo.log), diagnose: local agent up but
  # public down => restart the tunnel; local down => restart agent.
  load_env
  local fails=0
  while true; do
    sleep 60
    if [ -f "$PUBLIC_URL_FILE" ]; then
      if curl -s -m 10 -o /dev/null -w "%{http_code}" "$(cat "$PUBLIC_URL_FILE")/health" 2>/dev/null | grep -q "^200$"; then
        fails=0
      else
        fails=$((fails + 1))
      fi
    fi
    if grep -q "Port forwarding for .* expired" "$ROOT/logs/serveo.log" 2>/dev/null; then
      fails=2
    fi
    if [ "$fails" -ge 2 ]; then
      if curl -s -m 5 -o /dev/null "http://127.0.0.1:${PORT:-8788}/health" 2>/dev/null; then
        echo "$(date -Iseconds) public health failing (fails=$fails), local OK; restarting tunnel" >>"$ROOT/logs/supervisor.log"
        [ -f "$TUNNEL_PID_FILE" ] && kill "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
      else
        echo "$(date -Iseconds) local health failing; restarting agent" >>"$ROOT/logs/supervisor.log"
        [ -f "$AGENT_PID_FILE" ] && kill "$(cat "$AGENT_PID_FILE")" 2>/dev/null || true
      fi
      fails=0
      sleep 10
    fi
  done
}

cmd="${1:-status}"
case "$cmd" in
  start)
    if [ -f "$SUP_PID_FILE" ] && kill -0 "$(cat "$SUP_PID_FILE")" 2>/dev/null; then
      echo "supervisor already running (pid $(cat "$SUP_PID_FILE"))"
      exit 0
    fi
    nohup "$0" _run >>"$ROOT/logs/supervisor.log" 2>&1 &
    echo "supervisor started (pid $!)"
    ;;
  _run)
    supervisor_main
    ;;
  stop)
    [ -f "$TUNNEL_PID_FILE" ] && kill "$(cat "$TUNNEL_PID_FILE")" 2>/dev/null || true
    [ -f "$AGENT_PID_FILE" ] && kill "$(cat "$AGENT_PID_FILE")" 2>/dev/null || true
    # also stop any stray serveo ssh from earlier manual runs
    for pf in "$ROOT"/run/serveo-claim.pid "$ROOT"/run/serveo.pid; do
      [ -f "$pf" ] && kill "$(cat "$pf")" 2>/dev/null || true
    done
    if [ -f "$SUP_PID_FILE" ]; then
      sup="$(cat "$SUP_PID_FILE")"
      pkill -P "$sup" 2>/dev/null || true
      kill "$sup" 2>/dev/null || true
      rm -f "$SUP_PID_FILE"
    fi
    rm -f "$AGENT_PID_FILE" "$TUNNEL_PID_FILE"
    echo "supervisor stopped"
    ;;
  restart)
    "$0" stop; sleep 2; "$0" start
    ;;
  status)
    for f in supervisor agent serveo; do
      pf="$ROOT/run/$f.pid"
      if [ -f "$pf" ] && kill -0 "$(cat "$pf")" 2>/dev/null; then
        echo "$f: running (pid $(cat "$pf"))"
      else
        echo "$f: not running"
      fi
    done
    if [ -f "$PUBLIC_URL_FILE" ]; then
      echo "public URL: $(cat "$PUBLIC_URL_FILE")"
    else
      echo "public URL: (none — tunnel not up)"
    fi
    echo "--- agent log (last 3 lines) ---"
    tail -3 "$ROOT/logs/agent.log" 2>/dev/null || echo "(no agent log yet)"
    ;;
  *)
    echo "usage: $0 {start|stop|status|restart}"
    exit 1
    ;;
esac
