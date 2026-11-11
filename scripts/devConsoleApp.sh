#!/usr/bin/env bash
# Woodshed's own app (.woodshed/project.yaml): the dev console with its made-up sessions, for a session working on this
# repo. `start` runs it in a session of its own and returns once it answers; `stop` stops it.
#   bash scripts/devConsoleApp.sh start|stop
# DEV_CONSOLE_PORT moves it off 7690; the log and pid file are under ~/.cache/woodshed-dev-console/.
set -euo pipefail

PORT=${DEV_CONSOLE_PORT:-7690}
DIR=$HOME/.cache/woodshed-dev-console
LOG=$DIR/console.log
PID_FILE=$DIR/console.pid
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
WAIT_STEPS=60

answers() {
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null
}

start() {
  mkdir -p "$DIR"
  if answers; then
    echo "devConsoleApp: something already answers on port $PORT, left as it is"
    return 0
  fi
  echo "devConsoleApp: starting the dev console on port $PORT" | tee -a "$LOG"
  # In a session, Open app's requests name the session's app host, which only the console in front knows.
  local sessionApp=0
  if [[ -n ${SESSION_ID:-} ]]; then sessionApp=1; fi
  DEV_CONSOLE_SESSION_APP=$sessionApp setsid node "$REPO/console/bin/devConsole.mjs" "$PORT" >>"$LOG" 2>&1 </dev/null &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  for _ in $(seq "$WAIT_STEPS"); do
    if answers; then
      echo "devConsoleApp: up at http://localhost:$PORT/s/aaaa1111 (pid $pid)"
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then break; fi
    sleep 0.5
  done
  echo "devConsoleApp: the dev console did not answer on port $PORT; the end of its log:" >&2
  tail -n 20 "$LOG" >&2
  return 1
}

stop() {
  if [[ ! -s $PID_FILE ]]; then
    echo "devConsoleApp: no dev console started by this script"
    return 0
  fi
  local pid
  pid=$(cat "$PID_FILE")
  # setsid made it the leader of its own group, so this reaches the console it runs as well.
  kill -TERM -- "-$pid" 2>/dev/null || true
  for _ in $(seq "$WAIT_STEPS"); do
    if ! answers; then break; fi
    sleep 0.5
  done
  rm -f "$PID_FILE"
  if answers; then
    echo "devConsoleApp: port $PORT still answers after stopping pid $pid" >&2
    return 1
  fi
  echo "devConsoleApp: stopped (pid $pid)"
}

case ${1:-} in
  start) start ;;
  stop) stop ;;
  *)
    echo "usage: bash scripts/devConsoleApp.sh start|stop" >&2
    exit 2
    ;;
esac
