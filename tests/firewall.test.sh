#!/bin/sh
# Requires root, Python 3, network namespaces and an OpenWrt x86_64 rootfs with ip-full.
set -eu
: "${OPENWRT_TEST_ROOT:?Set OPENWRT_TEST_ROOT to an extracted OpenWrt x86_64 rootfs}"
if [ "${KROTEX_TEST_NETNS:-0}" != 1 ]; then
	export KROTEX_TEST_NETNS=1
	exec unshare -n sh "$0"
fi
cd "$(dirname "$0")/.."
RUNTIME="$OPENWRT_TEST_ROOT"
WORK="$(mktemp -d)"
PIDS=
cleanup() {
	for pid in $PIDS; do kill "$pid" 2>/dev/null || :; done
	for pid in $PIDS; do wait "$pid" 2>/dev/null || :; done
	rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
mkdir "$WORK/bin" "$WORK/lock"
for tool in nft ip; do
	case "$tool" in nft) command="$RUNTIME/usr/sbin/nft" ;; ip) command="$RUNTIME/usr/libexec/ip-full" ;; esac
	cat > "$WORK/bin/$tool" <<EOF
#!/bin/sh
exec "$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" $command "\$@"
EOF
done
cat > "$WORK/bin/jshn" <<EOF
#!/bin/sh
exec "$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" "$RUNTIME/usr/bin/jshn" "\$@"
EOF
chmod 0755 "$WORK/bin/"*
PATH="$WORK/bin:$PATH"
export PATH
sed -e "s|/usr/share/libubox/jshn.sh|$RUNTIME/usr/share/libubox/jshn.sh|g" \
	-e "s|/etc/krotex/routing.json|$WORK/routing.json|g" \
	-e "s|/var/run/krotex/routing-service-active|$WORK/active|g" \
	-e "s|/var/run/krotex/policy-owned|$WORK/policy-owned|g" \
	-e "s|/var/lock/krotex-firewall.lock|$WORK/lock/firewall|g" \
	package/krotex/files/firewall.sh > "$WORK/firewall"
fw() {
	"$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" "$RUNTIME/bin/busybox" ash "$WORK/firewall" "$@"
}
nft -f - <<'EOF'
table inet fw4 {
  chain input { type filter hook input priority 0; policy accept; }
}
EOF
touch "$WORK/active"
printf '{"enabled":true,"mac":"02:11:22:33:44:55"}\n' > "$WORK/routing.json"
fw apply
nft list table inet krotex > "$WORK/rules"
grep -q 'tproxy ip to 127.0.0.1:10809' "$WORK/rules"
grep -q 'tproxy ip to 127.0.0.1:10810' "$WORK/rules"
ip -4 rule show | grep -q 'fwmark 0x4b520000/0xffff0000 lookup 11490'
echo 'PASS: kernel accepts TPROXY rules, DNS capture and policy routing'

fw apply
test "$(nft list chain inet fw4 input | grep -c 'krotex-tproxy')" -eq 1
echo 'PASS: repeated application does not duplicate fw4 input rules'

nft delete table inet fw4
nft -f - <<'EOF'
table inet fw4 {
  chain input { type filter hook input priority 0; policy accept; }
}
EOF
fw apply
test "$(nft list chain inet fw4 input | grep -c 'krotex-tproxy')" -eq 1
echo 'PASS: applying after a fw4 reload restores the input exception'

ip -4 route del local default dev lo table 11490
fw apply
ip -4 route show table 11490 | grep -q 'local default dev lo'
ip -4 rule del pref 11490 fwmark 0x4b520000/0xffff0000 table 11490
fw apply
ip -4 rule show | grep -q 'fwmark 0x4b520000/0xffff0000 lookup 11490'
echo 'PASS: missing owned policy route or rule is repaired'

printf '{"enabled":true,"mac":"02:aa:bb:cc:dd:ee"}\n' > "$WORK/routing.json"
fw apply
nft list table inet krotex > "$WORK/rules"
grep -q '02:aa:bb:cc:dd:ee' "$WORK/rules"
! grep -q '02:11:22:33:44:55' "$WORK/rules"
echo 'PASS: switching device replaces the previous MAC atomically'

printf '{"enabled":false,"mac":"02:aa:bb:cc:dd:ee"}\n' > "$WORK/routing.json"
fw apply
! nft list table inet krotex >/dev/null 2>&1
! nft list chain inet fw4 input | grep -q 'krotex-tproxy'
! ip -4 rule show | grep -q '11490:'
echo 'PASS: disabling removes only Krotex rules and policy route'

printf '{"enabled":true,"mac":"02:11:22:33:44:55"}\n' > "$WORK/routing.json"
ip -4 rule add pref 11490 table 100
if fw apply > "$WORK/conflict" 2>&1; then
	echo 'FAIL: conflicting policy rule was overwritten' >&2
	exit 1
fi
ip -4 rule show | grep -q '11490:.*lookup 100'
! nft list table inet krotex >/dev/null 2>&1
fw stop
ip -4 rule show | grep -q '11490:.*lookup 100'
echo 'PASS: a foreign policy rule is preserved on conflict'

if [ -z "${XRAY_TEST_BINARY:-}" ]; then exit 0; fi
ip -4 rule del pref 11490 table 100
touch "$WORK/active"
ip link set lo up
unshare -n sleep 120 &
LAN=$!
PIDS="$PIDS $LAN"
unshare -n sleep 120 &
WAN=$!
PIDS="$PIDS $WAN"
unshare -n sleep 120 &
OTHER=$!
PIDS="$PIDS $OTHER"
sleep 1
ip link add lan0 type veth peer name client0
ip link set client0 netns "$LAN"
ip link add wan0 type veth peer name server0
ip link set server0 netns "$WAN"
ip link add lan1 type veth peer name other0
ip link set other0 netns "$OTHER"
ip link set lan0 address 02:00:00:00:55:01
ip link set lan1 address 02:00:00:00:56:01
ip link set wan0 address 02:00:00:00:02:01
nsenter -t "$WAN" -n ip link set server0 address 02:00:00:00:02:02
ip addr add 192.168.55.1/24 dev lan0
ip addr add 192.0.2.1/30 dev wan0
ip -6 addr add 2001:db8:1::1/64 dev lan0 nodad
ip -6 addr add 2001:db8:2::1/64 dev wan0 nodad
ip addr add 192.168.56.1/24 dev lan1
ip -6 addr add 2001:db8:4::1/64 dev lan1 nodad
ip link set lan0 up
ip link set wan0 up
ip link set lan1 up
nsenter -t "$LAN" -n ip link set lo up
nsenter -t "$LAN" -n ip link set client0 address 02:11:22:33:44:55
nsenter -t "$LAN" -n ip addr add 192.168.55.2/24 dev client0
nsenter -t "$LAN" -n ip -6 addr add 2001:db8:1::2/64 dev client0 nodad
nsenter -t "$LAN" -n ip link set client0 up
nsenter -t "$LAN" -n ip route add default via 192.168.55.1
nsenter -t "$LAN" -n ip -6 route add default via 2001:db8:1::1
nsenter -t "$OTHER" -n ip link set lo up
nsenter -t "$OTHER" -n ip link set other0 address 02:66:77:88:99:aa
nsenter -t "$OTHER" -n ip addr add 192.168.56.2/24 dev other0
nsenter -t "$OTHER" -n ip -6 addr add 2001:db8:4::2/64 dev other0 nodad
nsenter -t "$OTHER" -n ip link set other0 up
nsenter -t "$OTHER" -n ip route add default via 192.168.56.1
nsenter -t "$OTHER" -n ip -6 route add default via 2001:db8:4::1
nsenter -t "$WAN" -n ip link set lo up
nsenter -t "$WAN" -n ip addr add 192.0.2.2/30 dev server0
nsenter -t "$WAN" -n ip addr add 93.184.216.34/32 dev lo
nsenter -t "$WAN" -n ip -6 addr add 2001:db8:2::2/64 dev server0 nodad
nsenter -t "$WAN" -n ip -6 addr add 2001:db8:3::1/128 dev lo nodad
nsenter -t "$WAN" -n ip link set server0 up
nsenter -t "$WAN" -n ip route add 192.168.55.0/24 via 192.0.2.1
nsenter -t "$WAN" -n ip -6 route add 2001:db8:1::/64 via 2001:db8:2::1
nsenter -t "$WAN" -n ip route add 192.168.56.0/24 via 192.0.2.1
nsenter -t "$WAN" -n ip -6 route add 2001:db8:4::/64 via 2001:db8:2::1
ip route add 93.184.216.34/32 via 192.0.2.2
ip -6 route add 2001:db8:3::1/128 via 2001:db8:2::2
printf 1 > /proc/sys/net/ipv4/ip_forward
printf 1 > /proc/sys/net/ipv6/conf/all/forwarding
for interface in lan0 lan1 wan0; do
	printf 1 > "/proc/sys/net/ipv6/conf/$interface/forwarding"
done
# Keep namespace tests independent of router-advertisement / neighbor timing.
nsenter -t "$LAN" -n ip -6 neigh replace 2001:db8:1::1 lladdr 02:00:00:00:55:01 nud permanent dev client0
nsenter -t "$OTHER" -n ip -6 neigh replace 2001:db8:4::1 lladdr 02:00:00:00:56:01 nud permanent dev other0
ip -6 neigh replace 2001:db8:1::2 lladdr 02:11:22:33:44:55 nud permanent dev lan0
ip -6 neigh replace 2001:db8:4::2 lladdr 02:66:77:88:99:aa nud permanent dev lan1
ip -6 neigh replace 2001:db8:2::2 lladdr 02:00:00:00:02:02 nud permanent dev wan0
nsenter -t "$WAN" -n ip -6 neigh replace 2001:db8:2::1 lladdr 02:00:00:00:02:01 nud permanent dev server0

cat > "$WORK/endpoint.json" <<'EOF'
{
  "inbounds": [{"listen":"::","port":8080,"protocol":"dokodemo-door","settings":{"address":"127.0.0.1","port":9,"network":"tcp,udp"}}],
  "outbounds": [{"protocol":"blackhole","settings":{"response":{"type":"http"}}}]
}
EOF
cat > "$WORK/server.json" <<'EOF'
{
  "log":{"loglevel":"debug"},
  "dns":{"hosts":{"device.krotex.test":"203.0.113.77"},"servers":["localhost"]},
  "inbounds":[{"listen":"127.0.0.1","port":1443,"protocol":"vless","settings":{"clients":[{"id":"11111111-2222-4333-8444-555555555555"}],"decryption":"none"}}],
  "outbounds":[{"tag":"direct","protocol":"freedom"},{"tag":"dns","protocol":"dns"}],
  "routing":{"rules":[{"type":"field","port":"5353","outboundTag":"dns"}]}
}
EOF
cat > "$WORK/client.json" <<EOF
{
  "log":{"access":"$WORK/access.log","loglevel":"debug"},
  "outbounds":[{"tag":"proxy","protocol":"vless","settings":{"vnext":[{"address":"127.0.0.1","port":1443,"users":[{"id":"11111111-2222-4333-8444-555555555555","encryption":"none"}]}]}}]
}
EOF
nsenter -t "$WAN" -n ip addr add 1.1.1.1/32 dev lo
ip route add 1.1.1.1/32 via 192.0.2.2
nsenter -t "$WAN" -n python3 tests/dns-traffic.py serve > "$WORK/dns-server.log" 2>&1 &
PIDS="$PIDS $!"
python3 tests/dns-traffic.py serve 127.0.0.1 > "$WORK/router-dns.log" 2>&1 &
PIDS="$PIDS $!"
nsenter -t "$WAN" -n "$XRAY_TEST_BINARY" run -config "$WORK/endpoint.json" > "$WORK/endpoint.log" 2>&1 &
PIDS="$PIDS $!"
"$XRAY_TEST_BINARY" run -config "$WORK/server.json" > "$WORK/server.log" 2>&1 &
PIDS="$PIDS $!"
"$XRAY_TEST_BINARY" run -config "$WORK/client.json" -config package/krotex/files/transparent.json > "$WORK/client.log" 2>&1 &
CLIENT_PID=$!
PIDS="$PIDS $CLIENT_PID"
"$XRAY_TEST_BINARY" run -config "$WORK/endpoint.json" > "$WORK/local-endpoint.log" 2>&1 &
PIDS="$PIDS $!"
sleep 1
fw apply
code="$(nsenter -t "$LAN" -n curl --silent --show-error --noproxy '*' --max-time 8 -o /dev/null -w '%{http_code}' http://93.184.216.34:8080/)"
test "$code" = 403 || { cat "$WORK/client.log"; exit 1; }
grep -Eq '\[device-tproxy (>>|->) proxy\]' "$WORK/access.log"
echo 'PASS: selected device TCP traffic crosses real TPROXY and VLESS'

before="$(wc -l < "$WORK/access.log")"
"$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" \
	"$RUNTIME/bin/busybox" nslookup -type=A device.krotex.test 127.0.0.1 > "$WORK/router-dns-result" 2>&1 || {
	cat "$WORK/router-dns-result"
	tail -n 20 "$WORK/client.log"
	exit 1
}
grep -q '203.0.113.77' "$WORK/router-dns-result"
test "$(wc -l < "$WORK/access.log")" = "$before"
echo 'PASS: router loopback DNS stays outside device routing'

nsenter -t "$LAN" -n "$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" \
	"$RUNTIME/bin/busybox" nslookup -type=A device.krotex.test 192.168.55.1 > "$WORK/dns-result" 2>&1 || {
	cat "$WORK/dns-result" "$WORK/access.log"
	tail -n 35 "$WORK/client.log"
	tail -n 20 "$WORK/server.log"
	exit 1
}
grep -q '203.0.113.77' "$WORK/dns-result"
grep -Eq '\[device-dns (>>|->) device-dns-proxy\]' "$WORK/access.log"
echo 'PASS: device DNS is carried over UDP through VLESS'

nsenter -t "$LAN" -n python3 tests/dns-traffic.py probe || {
	tail -n 35 "$WORK/client.log" "$WORK/server.log" "$WORK/dns-server.log"
	exit 1
}

timeout 8 nsenter -t "$LAN" -n bash -c 'exec 3<>/dev/udp/93.184.216.34/5353; printf "\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x06device\x06krotex\x04test\x00\x00\x01\x00\x01" >&3; dd bs=512 count=1 <&3 2>/dev/null' > "$WORK/udp-result" || {
	tail -n 20 "$WORK/client.log" "$WORK/server.log"
	exit 1
}
tail -c 4 "$WORK/udp-result" | od -An -tu1 | grep -Eq '203[[:space:]]+0[[:space:]]+113[[:space:]]+77'
echo 'PASS: non-DNS UDP traffic also crosses TPROXY and VLESS'

before="$(wc -l < "$WORK/access.log")"
code="$(nsenter -t "$LAN" -n curl --silent --show-error --noproxy '*' --max-time 8 -o /dev/null -w '%{http_code}' http://192.168.55.1:8080/)"
test "$code" = 403
test "$(wc -l < "$WORK/access.log")" = "$before"
echo 'PASS: selected device can access the router without entering Xray'

before="$(wc -l < "$WORK/access.log")"
code="$(nsenter -t "$OTHER" -n curl --silent --show-error --noproxy '*' --max-time 8 -o /dev/null -w '%{http_code}' http://93.184.216.34:8080/)"
test "$code" = 403
test "$(wc -l < "$WORK/access.log")" = "$before"
echo 'PASS: an unselected MAC reaches the endpoint directly without Xray'
code="$(nsenter -t "$OTHER" -n curl -6 --silent --show-error --noproxy '*' --max-time 8 -o /dev/null -w '%{http_code}' 'http://[2001:db8:3::1]:8080/')"
test "$code" = 403

if nsenter -t "$LAN" -n curl -6 --silent --noproxy '*' --max-time 3 -o /dev/null 'http://[2001:db8:3::1]:8080/'; then
	echo 'FAIL: selected device bypassed routing over IPv6' >&2
	exit 1
fi
echo 'PASS: public IPv6 works for an unselected device and is blocked for the selected MAC'

printf '{"enabled":true,"macs":["02:11:22:33:44:55","02:66:77:88:99:aa"]}\n' > "$WORK/routing.json"
fw apply
for client in "$LAN" "$OTHER"; do
	before="$(wc -l < "$WORK/access.log")"
	code="$(nsenter -t "$client" -n curl --silent --show-error --noproxy '*' --max-time 8 -o /dev/null -w '%{http_code}' http://93.184.216.34:8080/)"
	test "$code" = 403
	test "$(wc -l < "$WORK/access.log")" -gt "$before"
done
nsenter -t "$OTHER" -n python3 tests/dns-traffic.py probe
if nsenter -t "$OTHER" -n curl -6 --silent --noproxy '*' --max-time 3 -o /dev/null 'http://[2001:db8:3::1]:8080/'; then
	echo 'FAIL: second selected device bypassed routing over IPv6' >&2
	exit 1
fi
echo 'PASS: both selected devices use TPROXY, including DNS and IPv6 bypass protection'

printf '{"enabled":true,"macs":["02:66:77:88:99:aa"]}\n' > "$WORK/routing.json"
fw apply
before="$(wc -l < "$WORK/access.log")"
code="$(nsenter -t "$LAN" -n curl --silent --show-error --noproxy '*' --max-time 8 -o /dev/null -w '%{http_code}' http://93.184.216.34:8080/)"
test "$code" = 403
test "$(wc -l < "$WORK/access.log")" = "$before"
code="$(nsenter -t "$OTHER" -n curl --silent --show-error --noproxy '*' --max-time 8 -o /dev/null -w '%{http_code}' http://93.184.216.34:8080/)"
test "$code" = 403
test "$(wc -l < "$WORK/access.log")" -gt "$before"
echo 'PASS: removing one MAC restores only that device to direct access'
printf '{"enabled":true,"macs":["02:11:22:33:44:55"]}\n' > "$WORK/routing.json"
fw apply

kill "$CLIENT_PID"
wait "$CLIENT_PID" 2>/dev/null || :
fw apply
if nsenter -t "$LAN" -n curl --silent --noproxy '*' --max-time 3 -o /dev/null http://93.184.216.34:8080/; then
	echo 'FAIL: selected device bypassed the stopped proxy' >&2
	exit 1
fi
echo 'PASS: a proxy crash does not silently send the selected device directly'

fw stop
code="$(nsenter -t "$LAN" -n curl --silent --show-error --noproxy '*' --max-time 8 -o /dev/null -w '%{http_code}' http://93.184.216.34:8080/)"
test "$code" = 403
echo 'PASS: explicit service stop removes interception and restores direct access'
