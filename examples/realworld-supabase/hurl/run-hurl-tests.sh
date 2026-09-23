#!/usr/bin/env bash
set -euo pipefail

# Runs the RealWorld API contract suite with hurl. The .hurl files come from
# https://github.com/realworld-apps/realworld/tree/main/specs/api/hurl
# Install hurl first: brew install hurl

DIR="$(cd "$(dirname "$0")" && pwd)"
HOST="${HOST:-http://localhost:3000}"
UID_VAL="${UID_VAL:-$(date +%s)$$}"

echo "Running Hurl tests against $HOST with uid=$UID_VAL"

FILES=("$@")
if [ ${#FILES[@]} -eq 0 ]; then
  FILES=("$DIR"/*.hurl)
fi

hurl --test \
  --jobs 1 \
  --variable "host=$HOST" \
  --variable "uid=$UID_VAL" \
  "${FILES[@]}"
