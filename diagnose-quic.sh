#!/bin/sh
# Temporary A/B test. Changes no saved configuration and restores its own rules.

CONFIG=/etc/krotex/routing.json
LOCK=/var/lock/krotex-quic-test.lock
WORK=
LOCKED=0
APPLIED=0

cleanup() {
	local chain handle
	if [ "$APPLIED" -eq 1 ]; then
		: > "$WORK/remove.nft"
		for chain in prerouting forward; do
			for handle in $(nft -a list chain inet krotex "$chain" 2>/dev/null | awk '/comment "krotex-quic-test"/ { print $NF }'); do
				case "$handle" in ''|*[!0-9]*) continue ;; esac
				printf 'delete rule inet krotex %s handle %s\n' "$chain" "$handle" >> "$WORK/remove.nft"
			done
		done
		if [ ! -s "$WORK/remove.nft" ] || nft -f "$WORK/remove.nft"; then
			printf '[Krotex] Temporary QUIC test removed.\n'
		else
			printf '[Krotex] Unable to restore rules. Run: /usr/libexec/krotex/firewall apply\n' >&2
		fi
	fi
	[ -z "$WORK" ] || rm -rf "$WORK"
	[ "$LOCKED" -eq 0 ] || rmdir "$LOCK"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

[ "$(id -u)" -eq 0 ] || { echo 'Run this test as root on the router.' >&2; exit 1; }
. /usr/share/libubox/jshn.sh
JSON_PREFIX=
_json_no_warning=1
json_load "$(cat "$CONFIG" 2>/dev/null)" || exit 1
json_get_var enabled enabled
json_get_var mac mac
[ "$enabled" = 1 ] || { echo 'Enable device routing in Krotex before running this test.' >&2; exit 1; }
printf '%s\n' "$mac" | grep -Eq '^([[:xdigit:]]{2}:){5}[[:xdigit:]]{2}$' || exit 1
nft list table inet krotex >/dev/null 2>&1 || { echo 'Krotex routing rules are not active.' >&2; exit 1; }
mkdir "$LOCK" 2>/dev/null || { echo 'A QUIC test is already running.' >&2; exit 1; }
LOCKED=1
umask 077
WORK="$(mktemp -d /tmp/krotex-quic.XXXXXX)" || exit 1
cat > "$WORK/test.nft" <<EOF
insert rule inet krotex prerouting ether saddr $mac meta nfproto ipv4 udp dport 443 return comment "krotex-quic-test"
insert rule inet krotex forward ether saddr $mac meta nfproto ipv4 udp dport 443 counter reject with icmpx type port-unreachable comment "krotex-quic-test"
EOF
nft -c -f "$WORK/test.nft" || exit 1
APPLIED=1
nft -f "$WORK/test.nft" || exit 1
printf '[Krotex] Temporary test is active for %s: UDP/443 is rejected immediately.\n' "$mac"
printf 'Keep this SSH session open. Open several new pages on the selected device.\n'
printf 'Press Enter when finished to restore the previous behavior.\n'
IFS= read -r answer
