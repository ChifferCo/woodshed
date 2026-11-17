#!/bin/bash
# A session's own Docker: the docker launcher runs the container under Sysbox (sysbox-runc) as root with this as its
# entrypoint (providers/local/dockerLauncher.mjs, ownDocker). Root here is an unprivileged user of the machine, so the
# daemon started here reaches nothing of the machine's: its containers, images and networks are this session's alone and
# go with it. Starts dockerd, waits for it, then runs the entrypoint as node, a member of the socket's group.
#
#   ownDocker.sh session    what the image's ENTRYPOINT and CMD would have run
#
# WOODSHED_DOCKERD, WOODSHED_DOCKERD_LOG, WOODSHED_DOCKER_SOCKET, WOODSHED_DOCKER_WAIT_SECONDS and WOODSHED_ENTRYPOINT
# stand in for the daemon, its log, its socket, its wait and the entrypoint in tests.
set -uo pipefail

log() { echo "[woodshed $(date -u +%H:%M:%S)] $*"; }

ENTRYPOINT=${WOODSHED_ENTRYPOINT:-/opt/woodshed/session/entrypoint.sh}
DOCKERD_LOG=${WOODSHED_DOCKERD_LOG:-/tmp/woodshed-dockerd.log}
SOCKET=${WOODSHED_DOCKER_SOCKET:-/var/run/docker.sock}
WAIT_SECONDS=${WOODSHED_DOCKER_WAIT_SECONDS:-30}

if [ "$(id -u)" != 0 ]; then
  # Not root: started some other way than the launcher's. The session still starts, with no Docker.
  log "WARNING: own Docker not started: ownDocker.sh runs as $(id -un), not root"
  exec "$ENTRYPOINT" "$@"
fi

# The daemon's log is the session's to read; the socket belongs to the docker group, which node is in.
touch "$DOCKERD_LOG" && chmod 644 "$DOCKERD_LOG"
${WOODSHED_DOCKERD:-dockerd} --group docker --host "unix://$SOCKET" >>"$DOCKERD_LOG" 2>&1 &
pid=$!

started=$SECONDS
ready=0
while [ $((SECONDS - started)) -lt "$WAIT_SECONDS" ]; do
  if [ -S "$SOCKET" ] && DOCKER_HOST="unix://$SOCKET" docker version >/dev/null 2>&1; then ready=1; break; fi
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.2
done
if [ "$ready" = 1 ]; then
  log "Own Docker ready" "(seconds: $((SECONDS - started)), log: $DOCKERD_LOG)"
else
  # The session starts anyway: claude's rules name the log, and `docker` says the daemon is not there.
  log "WARNING: own Docker did not start" "(seconds: $((SECONDS - started)), log: $DOCKERD_LOG): $(tail -n 3 "$DOCKERD_LOG" | tr '\n' ' ')"
fi

# node's own home and name, which `docker run --user 0` gave root's. --init-groups adds the docker group.
exec setpriv --reuid=node --regid=node --init-groups env HOME=/home/node USER=node LOGNAME=node "$ENTRYPOINT" "$@"
