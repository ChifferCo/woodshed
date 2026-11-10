#!/bin/bash
# Installed as /usr/local/bin/gh, ahead of the real /usr/bin/gh: every `gh` in a
# session runs with a token from githubToken.sh, so none needs a long-lived one.
GH_TOKEN=$(/opt/woodshed/session/githubToken.sh) || { echo "gh: could not get a GitHub token" >&2; exit 1; }
export GH_TOKEN
exec /usr/bin/gh "$@"
