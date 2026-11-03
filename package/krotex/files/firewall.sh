#!/bin/sh

. /usr/share/libubox/jshn.sh
_json_no_warning=1
CONFIG=/etc/krotex/routing.json
STATE=/var/run/krotex/routing-service-active
POLICY_STATE=/var/run/krotex/policy-owned
LOCK=/var/lock/krotex-firewall.lock
MARK=0x4b520000/0xffff0000
TABLE=11490
WORK=
LOCKED=0
NEW_POLICY=0

error() { printf '[Krotex] %s\n' "$*" >&2; return 1; }
cleanup() {
	[ -z "$WORK" ] || rm -rf "$WORK"
	[ "$LOCKED" -eq 0 ] || rmdir "$LOCK"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

valid_mac() {
	printf '%s\n' "$1" | grep -Eq '^([[:xdigit:]]{2}:){5}[[:xdigit:]]{2}$' || return 1
	[ "$1" != 00:00:00:00:00:00 ] && [ "$((0x${1%%:*} & 1))" -eq 0 ]
}

running() {
	local data active
	data="$(ubus -t 3 call service list '{"name":"krotex"}' 2>/dev/null)" || return 2
	json_load "$data" && json_select krotex && json_select instances && json_select main || return 1
	json_get_var active running
	[ "$active" = 1 ]
}

policy_remove() {
	# Delete only the precise rule and route owned by Krotex, never flush a table.
	[ -f "$POLICY_STATE" ] || return 0
	ip -4 rule del pref "$TABLE" fwmark "$MARK" table "$TABLE" 2>/dev/null || :
	ip -4 route del local default dev lo table "$TABLE" 2>/dev/null || :
	rm -f "$POLICY_STATE"
}

policy_apply() {
	local rules routes
	rules="$(ip -4 rule show)" || return 1
	rules="$(printf '%s\n' "$rules" | awk -v key="$TABLE:" '$1 == key')"
	routes="$(ip -4 route show table "$TABLE" 2>/dev/null)"
	if [ -n "$rules" ]; then
		if [ -f "$POLICY_STATE" ] && [ "$(printf '%s\n' "$rules" | wc -l)" -eq 1 ]; then
			case "$rules" in *"fwmark $MARK lookup $TABLE")
				if [ -z "$routes" ]; then
					ip -4 route add local default dev lo table "$TABLE"
					return $?
				fi
				case "$routes" in 'local default dev lo '*)
					[ "$(printf '%s\n' "$routes" | wc -l)" -eq 1 ] && return 0
					;;
				esac
				error "Routing table $TABLE contains an unexpected route."
				return 1
				;;
			esac
		fi
		error "Policy rule priority $TABLE is already in use."
		return 1
	fi
	if [ -f "$POLICY_STATE" ] && [ "$(printf '%s\n' "$routes" | wc -l)" -eq 1 ]; then
		case "$routes" in 'local default dev lo '*)
			ip -4 rule add pref "$TABLE" fwmark "$MARK" table "$TABLE"
			return $?
			;;
		esac
	fi
	[ -z "$routes" ] || {
		error "Routing table $TABLE is already in use."
		return 1
	}
	ip -4 route add local default dev lo table "$TABLE" || return 1
	if ! ip -4 rule add pref "$TABLE" fwmark "$MARK" table "$TABLE"; then
		ip -4 route del local default dev lo table "$TABLE" 2>/dev/null
		return 1
	fi
	NEW_POLICY=1
	if ! mkdir -p "$(dirname "$POLICY_STATE")" || ! touch "$POLICY_STATE"; then
		ip -4 rule del pref "$TABLE" fwmark "$MARK" table "$TABLE" 2>/dev/null
		ip -4 route del local default dev lo table "$TABLE" 2>/dev/null
		return 1
	fi
}

render_remove() {
	local handle
	for handle in $(nft -a list chain inet fw4 input 2>/dev/null | awk '/comment "krotex-tproxy"/ { print $NF }'); do
		case "$handle" in ''|*[!0-9]*) continue ;; esac
		printf 'delete rule inet fw4 input handle %s\n' "$handle"
	done
	if nft list table inet krotex >/dev/null 2>&1; then
		printf 'delete table inet krotex\n'
	fi
}

render() {
	valid_mac "$1" || { error 'Invalid device MAC address.'; return 1; }
	local mac="$1"
	render_remove
	cat <<EOF
add table inet krotex
add chain inet krotex prerouting { type filter hook prerouting priority -151; policy accept; }
add rule inet krotex prerouting ether saddr != $mac return
add rule inet krotex prerouting meta nfproto ipv4 meta l4proto { tcp, udp } th dport 53 meta mark set (meta mark & 0x0000ffff) | 0x4b520000 counter tproxy ip to 127.0.0.1:10810 accept
add rule inet krotex prerouting fib daddr type { local, broadcast, multicast } return
add rule inet krotex prerouting ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4 } return
add rule inet krotex prerouting meta nfproto ipv4 meta l4proto { tcp, udp } meta mark set (meta mark & 0x0000ffff) | 0x4b520000 counter tproxy ip to 127.0.0.1:10809 accept
add chain inet krotex forward { type filter hook forward priority -5; policy accept; }
add rule inet krotex forward ether saddr $mac ip6 daddr { fc00::/7, fe80::/10, ff00::/8 } return
add rule inet krotex forward ether saddr $mac meta nfproto ipv6 counter reject with icmpx type admin-prohibited
add chain inet krotex input { type filter hook input priority -5; policy accept; }
add rule inet krotex input ether saddr $mac meta nfproto ipv6 meta l4proto { tcp, udp } th dport 53 counter reject with icmpx type admin-prohibited
insert rule inet fw4 input ether saddr $mac meta mark & 0xffff0000 == 0x4b520000 meta l4proto { tcp, udp } counter accept comment "krotex-tproxy"
EOF
	# Existing offloaded connections must re-enter prerouting after selection.
	if nft list flowtable inet fw4 ft >/dev/null 2>&1; then
		printf 'flush flowtable inet fw4 ft\n'
	fi
}

remove_rules() {
	render_remove > "$WORK/remove.nft"
	[ ! -s "$WORK/remove.nft" ] || nft -f "$WORK/remove.nft" || return 1
	policy_remove
}

apply_rules() {
	local enabled mac
	if [ ! -f "$CONFIG" ]; then remove_rules; return; fi
	json_load "$(cat "$CONFIG")" || return 1
	json_get_var enabled enabled
	json_get_var mac mac
	[ "$enabled" = 1 ] || { remove_rules; return; }
	[ -f "$STATE" ] || { remove_rules; return; }
	valid_mac "$mac" || { error 'Invalid device MAC address.'; return 1; }
	nft list table inet fw4 >/dev/null 2>&1 || { error 'The fw4 firewall is not running.'; return 1; }
	render "$mac" > "$WORK/rules.nft" || return 1
	nft -c -f "$WORK/rules.nft" || return 1
	policy_apply || return 1
	if ! nft -f "$WORK/rules.nft"; then
		[ "$NEW_POLICY" -eq 0 ] || policy_remove
		return 1
	fi
}

case "${1:-apply}" in
	render) render "$2"; exit $? ;;
	status) nft list table inet krotex >/dev/null 2>&1; exit $? ;;
	apply|remove|start|stop) ;;
	*) exit 2 ;;
esac
for attempt in 1 2 3 4 5; do
	if mkdir "$LOCK" 2>/dev/null; then LOCKED=1; break; fi
	sleep 1
done
[ "$LOCKED" -eq 1 ] || { error 'Another firewall operation is running.'; exit 1; }
umask 077
WORK="$(mktemp -d /tmp/krotex-firewall.XXXXXX)" || exit 1
case "${1:-apply}" in
	apply) apply_rules ;;
	remove) remove_rules ;;
	start)
		ready=0
		for attempt in 1 2 3 4 5; do
			if running; then ready=1; break; fi
			sleep 1
		done
		[ "$ready" -eq 1 ] || { error 'Xray did not start.'; exit 1; }
		mkdir -p "$(dirname "$STATE")" && touch "$STATE" || exit 1
		apply_rules
		;;
	stop)
		rm -f "$STATE"
		remove_rules
		;;
esac
