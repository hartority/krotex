#!/bin/sh
set -eu

SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -f "$SOURCE/install.sh" ]; then
	exec sh "$SOURCE/install.sh" --update "$@"
fi

# A standalone copy of update.sh bootstraps the installer from GitHub.
WORK="$(mktemp -d /tmp/krotex-update.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
trap 'exit 1' HUP INT TERM
URL=https://raw.githubusercontent.com/hartority/krotex/main/install.sh
if command -v curl >/dev/null 2>&1; then
	curl --fail --location --retry 2 --connect-timeout 15 --max-time 180 "$URL" -o "$WORK/install.sh"
else
	wget -T 180 -O "$WORK/install.sh" "$URL"
fi
sh "$WORK/install.sh" --update "$@"
