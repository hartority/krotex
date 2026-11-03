#!/bin/sh
set -eu

# Empty on the router; tests substitute a temporary filesystem here.
SYSROOT=
REPOSITORY=hartority/krotex
REF=main
MODE=install
REMOTE=0
WORK=
CHANGED=0
WAS_RUNNING=0
WAS_ENABLED=0
BACKUP=

log() { printf '[Krotex] %s\n' "$*"; }
die() { log "$*" >&2; exit 1; }

download() {
	if command -v curl >/dev/null 2>&1; then
		curl --fail --location --retry 2 --connect-timeout 15 --max-time 180 "$1" -o "$2"
	elif command -v wget >/dev/null 2>&1; then
		wget -T 180 -O "$2" "$1"
	else
		die 'Install curl or wget with HTTPS support first.'
	fi
}

service_running() (
	# OpenWrt's jshn helpers intentionally read unset optional variables.
	set +u
	JSON_PREFIX=
	_json_no_warning=1
	local data running
	data="$(ubus -t 3 call service list '{"name":"krotex"}')" || return 2
	json_load "$data" || return 2
	json_select krotex && json_select instances && json_select main || return 1
	json_get_var running running
	[ "$running" = 1 ]
)

clear_cache() {
	# These are LuCI's generated cache files, not user configuration.
	rm -f "$SYSROOT"/tmp/luci-indexcache.*
	if [ -d "$SYSROOT/tmp/luci-modulecache" ]; then
		find "$SYSROOT/tmp/luci-modulecache" -type f -exec rm -f '{}' ';'
	fi
}

cleanup() {
	local code=$?
	set +e
	trap - EXIT HUP INT TERM
	if [ "$CHANGED" -eq 1 ]; then
		log 'Installation failed; restoring previous Krotex files.' >&2
		"$SYSROOT/etc/init.d/krotex" stop >/dev/null 2>&1 || :
		while IFS= read -r path; do
			rm -f "$SYSROOT/$path"
		done < "$WORK/managed"
		tar -xzf "$BACKUP" -C "${SYSROOT:-/}" || log "Restore failed. Backup: $BACKUP" >&2
		if [ -x "$SYSROOT/etc/init.d/krotex" ]; then
			if [ "$WAS_ENABLED" -eq 1 ]; then
				"$SYSROOT/etc/init.d/krotex" enable || :
			else
				"$SYSROOT/etc/init.d/krotex" disable || :
			fi
			[ "$WAS_RUNNING" -eq 0 ] || "$SYSROOT/etc/init.d/krotex" start || :
		fi
		clear_cache || :
		"$SYSROOT/etc/init.d/rpcd" restart || :
	fi
	[ -z "$WORK" ] || rm -rf "$WORK"
	rmdir "$SYSROOT/var/lock/krotex-setup.lock" 2>/dev/null || :
	exit "$code"
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		--update) MODE=update ;;
		--ref)
			[ "$#" -ge 2 ] || die '--ref needs a branch, tag, or commit.'
			REF=$2
			REMOTE=1
			shift
			;;
		-h|--help)
			printf 'Usage: sh install.sh [--update] [--ref BRANCH_OR_TAG_OR_COMMIT]\n'
			exit 0
			;;
		*) die "Unknown argument: $1" ;;
	esac
	shift
done
case "$REF" in ''|*[!a-zA-Z0-9._/-]*|*..*) die 'Invalid Git ref.' ;; esac

[ "$(id -u)" -eq 0 ] || die 'Run this script as root on the OpenWrt router.'
[ -f "$SYSROOT/etc/openwrt_release" ] || die 'This script requires OpenWrt.'
if [ "$MODE" = update ]; then
	[ -x "$SYSROOT/etc/init.d/krotex" ] || die 'Krotex is not installed. Run install.sh first.'
fi
mkdir -p "$SYSROOT/var/lock"
mkdir "$SYSROOT/var/lock/krotex-setup.lock" 2>/dev/null || die 'Another Krotex installation is running.'
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
WORK="$(mktemp -d /tmp/krotex-setup.XXXXXX)"
SOURCE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SOURCE_REF=local
if [ "$REMOTE" -eq 1 ] || [ ! -f "$SOURCE/package/krotex/files/krotex.init" ]; then
	log "Downloading $REPOSITORY ($REF)..."
	download "https://codeload.github.com/$REPOSITORY/tar.gz/$REF" "$WORK/source.tar.gz"
	mkdir "$WORK/source"
	# Minimal BusyBox tar has no --strip-components option. GitHub archives
	# contain one top-level directory; select it after ordinary extraction.
	tar -xzf "$WORK/source.tar.gz" -C "$WORK/source"
	set -- "$WORK/source/"*
	[ "$#" -eq 1 ] && [ -d "$1" ] || die 'Unexpected source archive structure.'
	SOURCE=$1
	SOURCE_REF=$REF
fi

CORE="$SOURCE/package/krotex/files"
LUCI="$SOURCE/package/luci-app-krotex"
for path in "$CORE/krotex.init" "$CORE/config.json" \
	"$CORE/routing.json" "$CORE/transparent.json" "$CORE/firewall.sh" "$CORE/40-krotex-routing" \
	"$LUCI/htdocs/luci-static/resources/view/krotex/status.js" \
	"$LUCI/htdocs/luci-static/resources/krotex/vless.js" \
	"$LUCI/root/usr/libexec/krotex/connection" \
	"$LUCI/root/usr/libexec/krotex/routing" \
	"$LUCI/root/usr/libexec/rpcd/krotex" \
	"$LUCI/root/usr/share/luci/menu.d/luci-app-krotex.json" \
	"$LUCI/root/usr/share/rpcd/acl.d/luci-app-krotex.json"; do
	[ -s "$path" ] || die "Missing source file: $path"
done

# Do not mix unmanaged source files with packages owned by opkg/apk.
if command -v opkg >/dev/null 2>&1; then
	MANAGER=opkg
	installed="$(opkg list-installed)"
	if printf '%s\n' "$installed" | grep -Eq '^(krotex|luci-app-krotex) - '; then
		die 'Krotex is package-managed. Update its packages or remove them before using source installation.'
	fi
elif command -v apk >/dev/null 2>&1; then
	MANAGER=apk
	if apk info -e krotex >/dev/null 2>&1 || apk info -e luci-app-krotex >/dev/null 2>&1; then
		die 'Krotex is package-managed. Update its packages or remove them before using source installation.'
	fi
else
	die 'Neither opkg nor apk was found.'
fi

log 'Installing runtime dependencies...'
if [ "$MANAGER" = opkg ]; then
	opkg update
	opkg install ca-bundle xray-core luci-base rpcd jshn ubus curl firewall4 nftables-json ip-full kmod-nft-tproxy
else
	apk update
	apk add ca-bundle xray-core luci-base rpcd jshn ubus curl firewall4 nftables-json ip-full kmod-nft-tproxy
fi
. "$SYSROOT/usr/share/libubox/jshn.sh"
[ -x "$SYSROOT/etc/init.d/rpcd" ] || die 'rpcd init script is missing.'

if [ -x "$SYSROOT/etc/init.d/krotex" ]; then
	"$SYSROOT/etc/init.d/krotex" enabled >/dev/null 2>&1 && WAS_ENABLED=1
	if service_running; then
		WAS_RUNNING=1
	else
		code=$?
		[ "$code" -eq 1 ] || die 'Unable to query procd; no Krotex files were changed.'
	fi
fi

# Check the preserved config before stopping the existing process.
CONFIG="$SYSROOT/etc/krotex/config.json"
[ -f "$CONFIG" ] || CONFIG="$CORE/config.json"
PROG="$SYSROOT/usr/bin/xray"
[ ! -x "$SYSROOT/usr/libexec/krotex/xray" ] || PROG="$SYSROOT/usr/libexec/krotex/xray"
"$PROG" run -test -config "$CONFIG" -config "$CORE/transparent.json"

cat > "$WORK/managed" <<'EOF'
etc/init.d/krotex
usr/libexec/rpcd/krotex
usr/libexec/krotex/connection
usr/libexec/krotex/routing
usr/libexec/krotex/firewall
usr/share/krotex/transparent.json
etc/uci-defaults/40-krotex-routing
usr/share/luci/menu.d/luci-app-krotex.json
usr/share/rpcd/acl.d/luci-app-krotex.json
www/luci-static/resources/view/krotex/status.js
www/luci-static/resources/krotex/vless.js
etc/krotex/config.json
etc/krotex/routing.json
etc/krotex/source-version
etc/sysupgrade.conf
etc/config/firewall
EOF
: > "$WORK/existing"
while IFS= read -r path; do
	[ ! -e "$SYSROOT/$path" ] || printf '%s\n' "$path" >> "$WORK/existing"
done < "$WORK/managed"
mkdir -p "$SYSROOT/etc/krotex/backups"
chmod 0700 "$SYSROOT/etc/krotex" "$SYSROOT/etc/krotex/backups"
BACKUP="$SYSROOT/etc/krotex/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.gz"
tar -czf "$BACKUP" -C "${SYSROOT:-/}" -T "$WORK/existing"
chmod 0600 "$BACKUP"
log "Backup: $BACKUP"

CHANGED=1
if [ "$WAS_RUNNING" -eq 1 ]; then
	"$SYSROOT/etc/init.d/krotex" stop
fi

copy_file() {
	mkdir -p "$(dirname "$2")"
	cp "$1" "$2"
	chmod "$3" "$2"
}
copy_file "$CORE/krotex.init" "$SYSROOT/etc/init.d/krotex" 0755
copy_file "$CORE/firewall.sh" "$SYSROOT/usr/libexec/krotex/firewall" 0755
copy_file "$CORE/transparent.json" "$SYSROOT/usr/share/krotex/transparent.json" 0644
copy_file "$CORE/40-krotex-routing" "$SYSROOT/etc/uci-defaults/40-krotex-routing" 0755
copy_file "$LUCI/root/usr/libexec/rpcd/krotex" "$SYSROOT/usr/libexec/rpcd/krotex" 0755
copy_file "$LUCI/root/usr/libexec/krotex/connection" "$SYSROOT/usr/libexec/krotex/connection" 0755
copy_file "$LUCI/root/usr/libexec/krotex/routing" "$SYSROOT/usr/libexec/krotex/routing" 0755
copy_file "$LUCI/root/usr/share/luci/menu.d/luci-app-krotex.json" "$SYSROOT/usr/share/luci/menu.d/luci-app-krotex.json" 0644
copy_file "$LUCI/root/usr/share/rpcd/acl.d/luci-app-krotex.json" "$SYSROOT/usr/share/rpcd/acl.d/luci-app-krotex.json" 0644
copy_file "$LUCI/htdocs/luci-static/resources/view/krotex/status.js" "$SYSROOT/www/luci-static/resources/view/krotex/status.js" 0644
copy_file "$LUCI/htdocs/luci-static/resources/krotex/vless.js" "$SYSROOT/www/luci-static/resources/krotex/vless.js" 0644
if [ ! -f "$SYSROOT/etc/krotex/config.json" ]; then
	copy_file "$CORE/config.json" "$SYSROOT/etc/krotex/config.json" 0600
fi
if [ ! -f "$SYSROOT/etc/krotex/routing.json" ]; then
	copy_file "$CORE/routing.json" "$SYSROOT/etc/krotex/routing.json" 0600
fi
sh "$SYSROOT/etc/uci-defaults/40-krotex-routing"
rm -f "$SYSROOT/etc/uci-defaults/40-krotex-routing"
version="$(sed -n 's/^PKG_VERSION:=//p' "$SOURCE/package/krotex/Makefile")"
printf '%s\n' "version=$version" "source=$REPOSITORY" "ref=$SOURCE_REF" > "$SYSROOT/etc/krotex/source-version"
touch "$SYSROOT/etc/sysupgrade.conf"
grep -qxF '/etc/krotex/' "$SYSROOT/etc/sysupgrade.conf" || printf '\n/etc/krotex/\n' >> "$SYSROOT/etc/sysupgrade.conf"
clear_cache
"$SYSROOT/etc/init.d/rpcd" restart

if [ "$MODE" = install ] || [ "$WAS_ENABLED" -eq 1 ]; then
	"$SYSROOT/etc/init.d/krotex" enable
else
	"$SYSROOT/etc/init.d/krotex" disable
fi
if [ "$MODE" = install ] || [ "$WAS_RUNNING" -eq 1 ]; then
	"$SYSROOT/etc/init.d/krotex" start
	ready=0
	for attempt in 1 2 3 4 5; do
		sleep 1
		if service_running; then ready=1; break; fi
	done
	[ "$ready" -eq 1 ] || die 'Xray did not start. See logread -e xray.'
fi
CHANGED=0
log "Krotex $version: $MODE complete. Open Services -> Krotex in LuCI."
