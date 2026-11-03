#!/bin/sh
set -eu

REF=main
case "$#" in
	0) ;;
	1)
		case "$1" in
			-h|--help) printf 'Usage: sh update.sh [--ref BRANCH_OR_TAG_OR_COMMIT]\n'; exit 0 ;;
			*) echo 'Usage: sh update.sh [--ref BRANCH_OR_TAG_OR_COMMIT]' >&2; exit 2 ;;
		esac
		;;
	2) [ "$1" = --ref ] || exit 2; REF=$2 ;;
	*) echo 'Usage: sh update.sh [--ref BRANCH_OR_TAG_OR_COMMIT]' >&2; exit 2 ;;
esac
case "$REF" in ''|*[!a-zA-Z0-9._/-]*|*..*) echo 'Invalid Git ref.' >&2; exit 2 ;; esac

SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ -f "$SOURCE/install.sh" ]; then
	exec sh "$SOURCE/install.sh" --update "$@"
fi

# The installer updates the app and its required core in one transaction.
# A standalone copy of update.sh bootstraps it from GitHub.
WORK="$(mktemp -d /tmp/krotex-update.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
trap 'exit 1' HUP INT TERM
URL="https://raw.githubusercontent.com/hartority/krotex/$REF/install.sh"
if command -v curl >/dev/null 2>&1; then
	curl --fail --location --retry 2 --connect-timeout 15 --max-time 180 "$URL" -o "$WORK/install.sh"
else
	wget -T 180 -O "$WORK/install.sh" "$URL"
fi
sh "$WORK/install.sh" --update "$@"
