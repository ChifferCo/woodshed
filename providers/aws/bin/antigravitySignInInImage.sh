#!/bin/bash
# A real Google sign-in for Antigravity, in the session image, by a person at this terminal: agy prints a link, they
# open it, sign in with the Google account of their AI Pro or Ultra plan, and paste the code back within agy's minute.
# agy keeps the sign-in in its file (no keyring in a container), which this copies out to a folder only this user reads.
# Then two checks, each in a fresh container holding nothing but a copy of that file, as a session does:
#
#   1. A real turn on it as it is.
#   2. The same with its access token marked expired, so agy renews it: whether Google's answer changed the refresh
#      token (by digest, never the value) says whether the sign-in rotates, and a third container on the original file
#      after that renewal says whether two sessions can hold the same one.
#
# Then `/usage` in print mode, for what the plan meter reads (agentPlanUsage.mjs). Nothing here prints a token.
#
#   bash woodshed/providers/aws/bin/antigravitySignInInImage.sh <image>
#
# <image> is a session image, such as one built from the worktree. The file is left in the folder it names, for the
# person to paste on My settings themselves (`jq . <file>`), then delete.
set -euo pipefail

image=${1:?usage: antigravitySignInInImage.sh <session image>}
name=woodshed-agy-sign-in
token=/home/node/.gemini/antigravity-cli/antigravity-oauth-token
out=$(mktemp -d)
chmod 700 "$out"
file=$out/antigravity-oauth-token
docker rm -f "$name" >/dev/null 2>&1 || true

echo "== Sign in: open the link agy prints, sign in, and paste the code here (agy waits 60 s)"
docker run -it --name "$name" -u node -w /tmp --entrypoint /opt/woodshed/session/bin/agy "$image" -p 'Reply with the single word ok.' || true
docker cp "$name:$token" "$file" 2>/dev/null || { docker rm -f "$name" >/dev/null; echo "No sign-in saved: agy wrote no $token"; exit 1; }
docker rm -f "$name" >/dev/null
chmod 600 "$file"
echo "== Saved: $file ($(wc -c < "$file") bytes, auth_method $(jq -r .auth_method "$file"), fields $(jq -c '.token | keys' "$file"))"

# Runs agy in a new container on a sign-in file given on stdin, and prints what it answered, the lines of its log on its
# sign-in, and a digest of the refresh token it holds after.
onlyTheFile() {
  docker run -i --rm -u node -w /tmp --entrypoint bash "$image" -c '
    set -u
    mkdir -p ~/.gemini/antigravity-cli && (umask 077 && cat > '"$token"')
    before=$(jq -r .token.refresh_token '"$token"' | sha256sum | cut -c1-12)
    said=$(/opt/woodshed/session/bin/agy -p "$1" --print-timeout 3m 2>&1); code=$?
    printf "%s\n" "$said" | tail -5
    echo "-- exit $code"
    grep -hE "token storage|keyringAuth|token refresh|ChainedAuth|Failed to save" ~/.gemini/antigravity-cli/log/*.log | cut -c1-200
    echo "-- refresh token digest before $before, after $(jq -r .token.refresh_token '"$token"' | sha256sum | cut -c1-12)"
  ' bash "$1"
}

echo "== 1. A turn in a container holding only the file"
onlyTheFile 'Reply with the single word ok.' < "$file"

echo "== 2. The same, with the access token marked expired, so agy renews it"
jq '.token.expiry = "2000-01-01T00:00:00Z"' "$file" | onlyTheFile 'Reply with the single word ok.'

echo "== 3. The original file again, after that renewal: does a second holder still work?"
jq '.token.expiry = "2000-01-01T00:00:00Z"' "$file" | onlyTheFile 'Reply with the single word ok.'

echo "== /usage, for the plan meter"
onlyTheFile '/usage' < "$file"

echo "== Done. Paste it on My settings with: jq . $file   then: rm -r $out"
