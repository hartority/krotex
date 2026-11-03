#!/bin/sh
set -e

SYSROOT=
VERSION=26.10.21
CORE="$SYSROOT/usr/libexec/krotex/xray"
INIT="$SYSROOT/etc/init.d/krotex"
LOCK="$SYSROOT/var/lock/krotex-setup.lock"
WORK=
NEW=
PREVIOUS=
CHANGED=0
WAS_RUNNING=0
HAD_PRIVATE=0

log() { printf '[Krotex] %s\n' "$*"; }
die() { log "$*" >&2; exit 1; }
download() {
	if command -v curl >/dev/null 2>&1; then
		curl --fail --location --retry 2 --connect-timeout 15 --max-time 180 "$1" -o "$2"
	else
		wget -T 180 -O "$2" "$1"
	fi
}
running() (
	local data running
	JSON_PREFIX=
	_json_no_warning=1
	data="$(ubus -t 3 call service list '{"name":"krotex"}' 2>/dev/null)" || return 2
	json_load "$data" || return 2
	json_select krotex && json_select instances && json_select main || return 1
	json_get_var running running
	[ "$running" = 1 ]
)
cleanup() {
	local code=$?
	set +e
	trap - EXIT HUP INT TERM
	if [ "$CHANGED" -eq 1 ]; then
		log 'Core update failed; restoring the previous core.' >&2
		"$INIT" stop >/dev/null 2>&1
		if [ "$HAD_PRIVATE" -eq 1 ]; then
			if ! mv -f "$PREVIOUS" "$CORE"; then
				log "Recovery copy retained at $PREVIOUS" >&2
				PREVIOUS=
			fi
		else
			rm -f "$CORE"
		fi
		[ "$WAS_RUNNING" -eq 0 ] || "$INIT" start >/dev/null 2>&1
	fi
	[ -z "$NEW" ] || rm -f "$NEW"
	[ -z "$PREVIOUS" ] || rm -f "$PREVIOUS"
	[ -z "$WORK" ] || rm -rf "$WORK"
	rmdir "$LOCK" 2>/dev/null || :
	exit "$code"
}

case "$#" in
	0) ;;
	1) case "$1" in -h|--help) printf 'Usage: sh update-core.sh [--version VERSION]\n'; exit 0 ;; *) exit 2 ;; esac ;;
	2) [ "$1" = --version ] || exit 2; VERSION=$2 ;;
	*) exit 2 ;;
esac
case "$VERSION" in ''|*[!0-9.]*|.*|*.) die 'Invalid Xray version.' ;; esac
[ "$(id -u)" -eq 0 ] || die 'Run as root on the OpenWrt router.'
[ -f "$SYSROOT/etc/openwrt_release" ] || die 'OpenWrt is required.'
[ -x "$INIT" ] || die 'Install Krotex first.'
grep -q '/usr/libexec/krotex/xray' "$INIT" || die 'Update Krotex before updating its core.'
case "$(uname -m)" in
	aarch64|arm64) ASSET=Xray-linux-arm64-v8a.zip ;;
	x86_64|amd64) ASSET=Xray-linux-64.zip ;;
	*) die 'This core updater supports arm64 and x86_64 routers.' ;;
esac
if ! command -v unzip >/dev/null 2>&1; then
	if command -v opkg >/dev/null 2>&1; then
		opkg update && opkg install unzip
	elif command -v apk >/dev/null 2>&1; then
		apk update && apk add unzip
	else
		die 'Install unzip first.'
	fi
fi
command -v sha256sum >/dev/null 2>&1 || die 'sha256sum is required.'
. "$SYSROOT/usr/share/libubox/jshn.sh"
mkdir -p "$(dirname "$LOCK")"
mkdir "$LOCK" 2>/dev/null || die 'Another Krotex operation is running.'
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
umask 077
WORK="$(mktemp -d /tmp/krotex-core.XXXXXX)"
URL="https://github.com/XTLS/Xray-core/releases/download/v$VERSION/$ASSET"
log "Downloading official Xray $VERSION ($ASSET)..."
download "$URL" "$WORK/core.zip"
download "$URL.dgst" "$WORK/core.dgst"
expected="$(awk -F'= ' '$1 == "SHA2-256" { print $2 }' "$WORK/core.dgst" | tr -d '\r')"
[ "${#expected}" -eq 64 ] || die 'The release has no valid SHA-256 checksum.'
case "$expected" in *[!a-fA-F0-9]*) die 'Invalid release checksum.' ;; esac
actual="$(sha256sum "$WORK/core.zip")"
[ "${actual%% *}" = "$expected" ] || die 'Xray archive checksum mismatch.'
mkdir -p "$(dirname "$CORE")"
NEW="$(mktemp "$SYSROOT/usr/libexec/krotex/.xray-new.XXXXXX")"
unzip -p "$WORK/core.zip" xray > "$NEW" || die 'Unable to extract Xray.'
chmod 0755 "$NEW"
"$NEW" version
set -- run -test -config "$SYSROOT/etc/krotex/config.json"
[ ! -r "$SYSROOT/usr/share/krotex/transparent.json" ] || set -- "$@" -config "$SYSROOT/usr/share/krotex/transparent.json"
"$NEW" "$@" || die 'The new core rejected the current configuration.'
if running; then WAS_RUNNING=1; else
	[ "$?" -eq 1 ] || die 'Unable to query procd.'
fi
if [ -e "$CORE" ]; then
	HAD_PRIVATE=1
	PREVIOUS="$(mktemp "$SYSROOT/usr/libexec/krotex/.xray-previous.XXXXXX")"
	cp -p "$CORE" "$PREVIOUS"
fi
mv -f "$NEW" "$CORE"
NEW=
CHANGED=1
if [ "$WAS_RUNNING" -eq 1 ]; then
	"$INIT" restart
	ready=0
	for attempt in 1 2 3 4 5; do
		sleep 1
		if running; then ready=1; break; fi
	done
	[ "$ready" -eq 1 ] || die 'Krotex did not start with the new core.'
fi
CHANGED=0
log "Xray $VERSION installed for Krotex at $CORE. The package-managed core is unchanged."
