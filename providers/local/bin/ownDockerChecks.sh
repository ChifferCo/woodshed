#!/bin/bash
# What a session's claude finds of its own Docker, run in its place by ownDockerInImage.mjs: ownDocker.sh starts the
# daemon as root, then runs this as node (WOODSHED_ENTRYPOINT), the way it runs the entrypoint. Prints `[check] ok:` or
# `[check] FAIL:` for each, then `[check] result: pass` or `fail`, and waits for the host's own checks.
set -u

say() { echo "[check] $*"; }
failed=0
check() {
  local name=$1 out
  shift
  if out=$("$@" 2>&1); then
    say "ok: $name"
    [ -n "$out" ] && printf '%s\n' "$out" | tail -n 4 | sed 's/^/    /'
  else
    say "FAIL: $name"
    printf '%s\n' "$out" | tail -n 8 | sed 's/^/    /'
    failed=1
  fi
}

say "who: $(id)"
check 'runs as node, not root' test "$(id -u)" = 1000
check 'node is in the docker group' sh -c 'id -nG | grep -qw docker'
check 'DOCKER_HOST is the own daemon' test "${DOCKER_HOST:-}" = unix:///var/run/docker.sock
check 'WOODSHED_SESSION_DOCKER is own' test "${WOODSHED_SESSION_DOCKER:-}" = own
check 'the daemon answers' docker version --format 'client {{.Client.Version}}, server {{.Server.Version}}'
check 'the daemon is this container' sh -c "docker info --format 'name={{.Name}} driver={{.Driver}} cgroup={{.CgroupVersion}}' | tee /dev/stderr | grep -q \"name=\$(hostname)\""
check 'docker run hello-world' sh -c 'docker run --rm hello-world | grep "Hello from Docker!"'
mkdir -p /tmp/own-docker-check
cat >/tmp/own-docker-check/Dockerfile <<'EOF'
FROM busybox:1.37
RUN echo built inside the session > /built
CMD ["cat", "/built"]
EOF
check 'docker build' docker build -q -t own-docker-check /tmp/own-docker-check
check 'the built image runs' sh -c 'docker run --rm own-docker-check | grep -q "built inside the session"'
cat >/tmp/own-docker-check/compose.yml <<'EOF'
services:
  web:
    image: nginx:1.27-alpine
    ports: ["127.0.0.1:18080:80"]
  probe:
    image: curlimages/curl:8.11.1
    depends_on: [web]
    command: ["sh", "-c", "for i in $(seq 30); do curl -fsS http://web/ >/dev/null && echo web answered && exit 0; sleep 1; done; exit 1"]
EOF
check 'docker compose up, one service reaching another' docker compose -f /tmp/own-docker-check/compose.yml up --abort-on-container-exit --exit-code-from probe
check 'a published port answers on the session'"'"'s 127.0.0.1' sh -c '
  docker compose -f /tmp/own-docker-check/compose.yml up -d web >/dev/null 2>&1
  for i in $(seq 30); do curl -fsS -o /dev/null http://127.0.0.1:18080/ && exit 0; sleep 1; done; exit 1'
docker compose -f /tmp/own-docker-check/compose.yml down >/dev/null 2>&1
check 'no --privileged: the machine'"'"'s disks are not here' sh -c '! ls /dev/sda /dev/nvme0n1 /dev/vda 2>/dev/null | grep -q .'
check 'no sudo for node' sh -c '! sudo -n true 2>/dev/null'
say "containers in the session's own Docker: $(docker ps -aq | wc -l | tr -d ' '), images: $(docker images -q | sort -u | wc -l | tr -d ' ')"

if [ "$failed" = 0 ]; then say 'result: pass'; else say 'result: fail'; fi
exec sleep 600
