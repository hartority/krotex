#!/bin/sh

. /usr/share/libubox/jshn.sh
_json_no_warning=1
CONFIG=/etc/krotex/routing.json
CORE_CONFIG=/etc/krotex/config.json
COMPILER=/usr/share/krotex/sections.uc
STATE=/var/run/krotex/routing-service-active
STOPPED=/var/run/krotex/routing-service-stopped
INIT=/etc/init.d/krotex
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
	case "$1" in ''|*[!a-fA-F0-9:]*) return 1 ;; esac
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

add_lan_device() {
	case "$1" in ''|lo|*[!a-zA-Z0-9_.:@-]*) return 1 ;; esac
	[ "${#1}" -le 15 ] || return 1
	case " $LAN_DEVICES " in *" $1 "*) return 0 ;; esac
	LAN_DEVICES="${LAN_DEVICES:+$LAN_DEVICES }$1"
}

lan_devices() {
	local zone name network data device
	LAN_DEVICES=
	for zone in $(uci -q show firewall | sed -n 's/^\(firewall\.[^.=]*\)=zone$/\1/p'); do
		name="$(uci -q get "$zone.name")"
		[ "$name" = lan ] || continue
		for device in $(uci -q get "$zone.device"); do
			add_lan_device "$device" || { error 'Invalid LAN device.'; return 1; }
		done
		for network in $(uci -q get "$zone.network"); do
			case "$network" in ''|*[!a-zA-Z0-9_-]*) error 'Invalid LAN network.'; return 1 ;; esac
			data="$(ubus -t 3 call "network.interface.$network" status 2>/dev/null)" || continue
			json_load "$data" || continue
			json_get_var device l3_device
			[ -n "$device" ] || json_get_var device device
			[ -n "$device" ] || continue
			add_lan_device "$device" || { error 'Invalid LAN device.'; return 1; }
		done
	done
	[ -n "$LAN_DEVICES" ] || { error 'Unable to find devices in the LAN firewall zone.'; return 1; }
}

render() {
	local entry mac='' count=0 selector='' devices='' assigned port dns
	if [ "${2:-selected}" = all ]; then
		lan_devices || return 1
		for entry in $LAN_DEVICES; do devices="${devices:+$devices, }\"$entry\""; done
		selector="iifname { $devices }"
	else
		for entry in $1; do
			valid_mac "$entry" || { error 'Invalid device MAC address.'; return 1; }
			count=$((count + 1)); [ "$count" -le 128 ] || return 1
			mac="${mac:+$mac, }$entry"
		done
		if [ -n "$mac" ]; then selector="ether saddr { $mac }"
		elif [ -z "${DEVICE_ROUTES:-}" ] || [ ! -s "$DEVICE_ROUTES" ]; then return 1
		fi
	fi
	render_remove
	cat <<EOF
add table inet krotex
add chain inet krotex prerouting { type filter hook prerouting priority -151; policy accept; }
add chain inet krotex forward { type filter hook forward priority -5; policy accept; }
add chain inet krotex input { type filter hook input priority -5; policy accept; }
EOF
	if [ -n "${SMART_POLICY:-}" ] && [ -s "$SMART_POLICY" ]; then cat "$SMART_POLICY"
	else printf 'add chain inet krotex smart_policy\n'
	fi
	# Specific device captures precede the common device routing rules.
	if [ -n "${DEVICE_ROUTES:-}" ] && [ -s "$DEVICE_ROUTES" ]; then
		while IFS='|' read -r assigned port dns; do
			local members='' device
			for device in $assigned; do members="${members:+$members, }$device"; done
			render_capture "ether saddr { $members }" "section_$port" "$port" "$dns"
		done < "$DEVICE_ROUTES"
	fi
	[ -z "$selector" ] || render_capture "$selector" device_prerouting 10809 10810
	# Existing offloaded connections must re-enter prerouting after selection.
	if nft list flowtable inet fw4 ft >/dev/null 2>&1; then
		printf 'flush flowtable inet fw4 ft\n'
	fi
}


render_capture() {
	local selector="$1" chain="$2" port="$3" dns="$4"
	cat <<EOF
add chain inet krotex $chain
add rule inet krotex prerouting $selector jump $chain
EOF
	if [ "$chain" = device_prerouting ]; then
		printf 'add rule inet krotex %s meta nfproto ipv4 jump smart_policy\n' "$chain"
	fi
	cat <<EOF
add rule inet krotex $chain meta nfproto ipv4 meta l4proto { tcp, udp } th dport 53 meta mark set (meta mark & 0x0000ffff) | 0x4b520000 counter tproxy ip to 127.0.0.1:$dns accept
add rule inet krotex $chain fib daddr type { local, broadcast, multicast } return
add rule inet krotex $chain ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/4, 240.0.0.0/4 } return
add rule inet krotex $chain meta nfproto ipv4 udp dport 443 counter drop
EOF
	if [ "$chain" != device_prerouting ]; then
		printf 'add rule inet krotex %s meta nfproto ipv4 meta l4proto != { tcp, udp } counter drop\n' "$chain"
	fi
	cat <<EOF
add rule inet krotex $chain meta nfproto ipv4 meta l4proto { tcp, udp } meta mark set (meta mark & 0x0000ffff) | 0x4b520000 counter tproxy ip to 127.0.0.1:$port accept
add rule inet krotex forward $selector ip6 daddr { fc00::/7, fe80::/10, ff00::/8 } return
add rule inet krotex forward $selector meta nfproto ipv6 counter reject with icmpx type admin-prohibited
add rule inet krotex input $selector meta nfproto ipv6 meta l4proto { tcp, udp } th dport 53 counter reject with icmpx type admin-prohibited
insert rule inet fw4 input $selector meta mark & 0xffff0000 == 0x4b520000 meta l4proto { tcp, udp } counter accept comment "krotex-tproxy"
EOF
}

read_device_routes() {
	local routes route keys members key mac assigned port dns
	DEVICE_ROUTES="$WORK/device-routes"
	: > "$DEVICE_ROUTES"
	SMART_POLICY="$WORK/smart-policy.nft"
	: > "$SMART_POLICY"
	[ -f "$CORE_CONFIG" ] || return 0
	cp "$CORE_CONFIG" "$WORK/core.json" || return 1
	ucode "$COMPILER" firewall "$WORK/core.json" > "$SMART_POLICY" || return 1
	routes="$(ucode "$COMPILER" devices "$WORK/core.json")" || return 1
	json_load "$routes" && json_select routes || return 1
	json_get_keys routes
	for route in $routes; do
		json_select "$route" || return 1
		json_get_var port port; json_get_var dns dns_port
		case "$port:$dns" in *[!0-9:]*|:*) return 1 ;; esac
		[ "$port" -ge 12080 ] && [ "$port" -le 12111 ] && [ "$dns" -ge 12112 ] && [ "$dns" -le 12143 ] || return 1
		json_select macs || return 1
		json_get_keys keys
		assigned=
		for key in $keys; do
			json_get_var mac "$key"; valid_mac "$mac" || return 1
			assigned="${assigned:+$assigned }$mac"
		done
		[ -n "$assigned" ] || return 1
		printf '%s|%s|%s\n' "$assigned" "$port" "$dns" >> "$DEVICE_ROUTES"
		json_select ..; json_select ..
	done
}

remove_rules() {
	render_remove > "$WORK/remove.nft"
	[ ! -s "$WORK/remove.nft" ] || nft -f "$WORK/remove.nft" || return 1
	policy_remove
}

apply_rules() {
	local enabled mac kind keys key macs='' mode
	if [ ! -f "$CONFIG" ]; then remove_rules; return; fi
	json_load "$(cat "$CONFIG")" || return 1
	json_get_var enabled enabled
	if [ ! -f "$STATE" ]; then
		# On boot, protect an enabled service before its process is ready.
		# An explicit manual stop remains direct across firewall reloads.
		if [ ! -f "$STOPPED" ] && [ -x "$INIT" ] && "$INIT" enabled >/dev/null 2>&1; then
			mkdir -p "$(dirname "$STATE")" && touch "$STATE" || return 1
		else remove_rules; return
		fi
	fi
	json_get_var mode mode
	case "$mode" in ''|selected) mode=selected ;; all) ;; *) error 'Invalid routing mode.'; return 1 ;; esac
	json_get_type kind macs
	if [ "$kind" = array ]; then
		json_select macs
		json_get_keys keys
		for key in $keys; do
			json_get_type kind "$key"
			[ "$kind" = string ] || return 1
			json_get_var mac "$key"
			valid_mac "$mac" || { error 'Invalid device MAC address.'; return 1; }
			case " $macs " in *" $mac "*) continue ;; esac
			macs="${macs:+$macs }$mac"
		done
	else
		[ -z "$kind" ] || return 1
		json_get_var mac mac
		if [ "$enabled" = 1 ]; then
			valid_mac "$mac" || { error 'Invalid device MAC address.'; return 1; }
			macs=$mac
		fi
	fi
	if [ "$enabled" != 1 ]; then mode=selected; macs=; fi
	read_device_routes || { error 'Unable to load device-specific routes.'; return 1; }
	[ "$mode" = all ] || [ -n "$macs" ] || [ -s "$DEVICE_ROUTES" ] || { remove_rules; return; }
	nft list table inet fw4 >/dev/null 2>&1 || { error 'The fw4 firewall is not running.'; return 1; }
	render "$macs" "$mode" > "$WORK/rules.nft" || return 1
	nft -c -f "$WORK/rules.nft" || return 1
	policy_apply || return 1
	if ! nft -f "$WORK/rules.nft"; then
		[ "$NEW_POLICY" -eq 0 ] || policy_remove
		return 1
	fi
}

# Internal restarts and rollbacks must never temporarily release routed traffic.
if [ "${1:-apply}" = stop ] && [ "${KROTEX_KEEP_ROUTING:-0}" = 1 ]; then set -- hold; fi
case "${1:-apply}" in
	render) render "$2"; exit $? ;;
	status) nft list table inet krotex >/dev/null 2>&1; exit $? ;;
	apply|remove|start|stop|arm|hold) ;;
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
	hold) : ;;
	arm)
		mkdir -p "$(dirname "$STATE")" && touch "$STATE" || exit 1
		rm -f "$STOPPED"
		apply_rules
		;;
	remove) remove_rules ;;
	start)
		ready=0
		for attempt in 1 2 3 4 5; do
			if running; then ready=1; break; fi
			sleep 1
		done
		[ "$ready" -eq 1 ] || { error 'Xray did not start.'; exit 1; }
		mkdir -p "$(dirname "$STATE")" && touch "$STATE" || exit 1
		rm -f "$STOPPED"
		apply_rules
		;;
	stop)
		mkdir -p "$(dirname "$STOPPED")" && touch "$STOPPED" || exit 1
		rm -f "$STATE"
		remove_rules
		;;
esac
