#!/bin/sh
set -eu
owner="${DATA_UID:-node}"
if [ -n "${DATA_UID:-}" ]; then
    directory="$(dirname "$DATA_PATH")"
    mkdir -p "$directory"
    chown -R "$owner:$owner" "$directory"
    chmod 0700 "$directory"
fi
exec su-exec "$owner:$owner" "$@"
