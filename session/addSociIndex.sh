#!/usr/bin/env bash
# Adds a SOCI index to a session image already in ECR, so Fargate starts the
# container before the whole image has downloaded and fetches files as they are
# read. Without an index Fargate pulls the image in full, so a failure here
# only costs startup time.
#
# Usage: addSociIndex.sh <repository url> <tag> [more tags]
# The first tag is converted, and every tag is then pushed pointing at the
# SOCI-enabled image. Needs `soci` and `nerdctl` on PATH, the containerd
# that Docker runs, sudo, and AWS credentials that can pull and push the repository.
set -euo pipefail

repo=$1
shift
src="$repo:$1"
converted="$repo:soci-$1"
soci=$(command -v soci)
nerdctl=$(command -v nerdctl)

# Root's own registry login would outlive the run on a machine that is not throwaway.
DOCKER_CONFIG=$(mktemp -d)
export DOCKER_CONFIG
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
as_root() { sudo env DOCKER_CONFIG="$DOCKER_CONFIG" "$@"; }

aws ecr get-login-password | as_root "$nerdctl" login --username AWS --password-stdin "${repo%%/*}"

# No unpack: soci reads the compressed layers, and an unpacked copy would need another 8 GB of disk.
as_root "$nerdctl" pull --quiet --all-platforms --unpack=false "$src"
as_root "$soci" convert --all-platforms "$src" "$converted"

for tag in "$@"; do
  as_root "$nerdctl" tag "$converted" "$repo:$tag"
  # All platforms, or nerdctl pushes only the image manifest and leaves the SOCI index behind.
  as_root "$nerdctl" push --quiet --all-platforms "$repo:$tag"
done
as_root "$nerdctl" rmi --force "$converted" "${@/#/$repo:}" > /dev/null
