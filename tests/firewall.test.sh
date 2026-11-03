#!/bin/sh
# Requires root, Python 3, OpenSSL, network namespaces and an OpenWrt x86_64 rootfs with ip-full.
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
cat > "$WORK/bin/ucode" <<EOF
#!/bin/sh
exec "$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" "$RUNTIME/usr/bin/ucode" -L "$RUNTIME/usr/lib/ucode" "\$@"
EOF
chmod 0755 "$WORK/bin/ucode"
cat > "$WORK/bin/uci" <<EOF
#!/bin/sh
case "\$*" in
  '-q show firewall') printf 'firewall.lan=zone\nfirewall.wan=zone\n' ;;
  '-q get firewall.lan.name') echo lan ;;
  '-q get firewall.wan.name') echo wan ;;
  '-q get firewall.lan.network') [ -f "$WORK/no-lan" ] || echo 'lan lan2' ;;
  *) exit 1 ;;
esac
EOF
cat > "$WORK/bin/ubus" <<'EOF'
#!/bin/sh
case "$*" in
  *network.interface.lan2*) echo '{"l3_device":"lan1"}' ;;
  *network.interface.lan*) echo '{"l3_device":"lan0"}' ;;
  *) exit 1 ;;
esac
EOF
chmod 0755 "$WORK/bin/uci" "$WORK/bin/ubus"
PATH="$WORK/bin:$PATH"
export PATH
sed -e "s|/usr/share/libubox/jshn.sh|$RUNTIME/usr/share/libubox/jshn.sh|g" \
	-e "s|/etc/krotex/routing.json|$WORK/routing.json|g" \
	-e "s|/etc/krotex/config.json|$WORK/core-config.json|g" \
	-e "s|/usr/share/krotex/sections.uc|$(pwd)/package/krotex/files/sections.uc|g" \
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
"$XRAY_TEST_BINARY" run -config package/krotex/files/transparent.json -config "$WORK/client.json" > "$WORK/client.log" 2>&1 &
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

# Allow section changes to be tested without the unrelated DNS stress matrix.
if [ "${KROTEX_TEST_SECTIONS_ONLY:-0}" != 1 ]; then
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

printf '{"enabled":true,"mode":"all","macs":[]}\n' > "$WORK/routing.json"
fw apply
for client in "$LAN" "$OTHER"; do
	before="$(wc -l < "$WORK/access.log")"
	code="$(nsenter -t "$client" -n curl --silent --show-error --noproxy '*' --max-time 6 -o /dev/null -w '%{http_code}' http://93.184.216.34:8080/)"
	test "$code" = 403
	test "$(wc -l < "$WORK/access.log")" -gt "$before"
	nsenter -t "$client" -n python3 tests/dns-traffic.py probe
	if nsenter -t "$client" -n curl -6 --silent --noproxy '*' --max-time 3 -o /dev/null 'http://[2001:db8:3::1]:8080/'; then
		echo 'FAIL: all-device mode allowed an IPv6 bypass' >&2
		exit 1
	fi
done
before="$(wc -l < "$WORK/access.log")"
"$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" \
	"$RUNTIME/bin/busybox" nslookup -type=A device.krotex.test 127.0.0.1 > "$WORK/all-router-dns" 2>&1
grep -q '203.0.113.77' "$WORK/all-router-dns"
test "$(wc -l < "$WORK/access.log")" = "$before"
echo 'PASS: all-device mode captures TCP and DNS on both LANs with no MAC list and leaves loopback DNS direct'

nsenter -t "$OTHER" -n ip addr add 8.8.4.4/32 dev lo
ip route add 8.8.4.4/32 via 192.168.56.2
nsenter -t "$WAN" -n ip route add 8.8.4.4/32 via 192.0.2.1
nsenter -t "$OTHER" -n "$XRAY_TEST_BINARY" run -config "$WORK/endpoint.json" > "$WORK/other-endpoint.log" 2>&1 &
PIDS="$PIDS $!"
sleep .2
before="$(wc -l < "$WORK/access.log")"
code="$(nsenter -t "$WAN" -n curl --silent --show-error --noproxy '*' --max-time 6 -o /dev/null -w '%{http_code}' http://8.8.4.4:8080/)"
test "$code" = 403
test "$(wc -l < "$WORK/access.log")" = "$before"
echo 'PASS: all-device mode does not capture connections entering from WAN'
touch "$WORK/no-lan"
if fw apply > "$WORK/all-error" 2>&1; then
	echo 'FAIL: all-device mode accepted missing LAN interfaces' >&2
	exit 1
fi
nft list table inet krotex | grep -q 'iifname'
ip -4 rule show | grep -q '11490:'
rm "$WORK/no-lan"
echo 'PASS: unavailable LAN discovery leaves the previous working rules intact'

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

fi
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

printf '{"enabled":true,"mode":"all","macs":[]}\n' > "$WORK/routing.json"
fw apply
if nsenter -t "$OTHER" -n curl --silent --noproxy '*' --max-time 3 -o /dev/null http://93.184.216.34:8080/; then
	echo 'FAIL: all-device mode bypassed the stopped proxy' >&2
	exit 1
fi
echo 'PASS: all-device mode stays closed after a proxy crash'

fw stop
code="$(nsenter -t "$LAN" -n curl --silent --show-error --noproxy '*' --max-time 8 -o /dev/null -w '%{http_code}' http://93.184.216.34:8080/)"
test "$code" = 403
echo 'PASS: explicit service stop removes interception and restores direct access'

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=vpn.krotex.test' \
	-addext 'subjectAltName=DNS:vpn.krotex.test,DNS:*.krotex.test' \
	-keyout "$WORK/server.key" -out "$WORK/server.crt" > "$WORK/cert.log" 2>&1
python3 tests/sections-traffic.py "$WORK"
for index in 1 2; do
	"$XRAY_TEST_BINARY" run -config "$WORK/vpn$index.json" > "$WORK/vpn$index.log" 2>&1 &
	[ "$index" != 1 ] || VPN1_PID=$!
	PIDS="$PIDS $!"
done
nsenter -t "$WAN" -n openssl s_server -quiet -www -accept 8443 -cert "$WORK/server.crt" -key "$WORK/server.key" > "$WORK/https.log" 2>&1 &
PIDS="$PIDS $!"
ucode package/krotex/files/sections.uc compile "$WORK/client.json" "$WORK/sections-request.json" > "$WORK/sections-client.json"
python3 tests/sections-traffic.py "$WORK" trust
cp "$WORK/sections-client.json" "$WORK/core-config.json"
"$XRAY_TEST_BINARY" run -test -config package/krotex/files/transparent.json -config "$WORK/sections-client.json" > "$WORK/sections-validation.log" 2>&1 || { cat "$WORK/sections-validation.log"; exit 1; }
"$XRAY_TEST_BINARY" run -config package/krotex/files/transparent.json -config "$WORK/sections-client.json" > "$WORK/sections-client.log" 2>&1 &
SECTIONS_PID=$!
PIDS="$PIDS $SECTIONS_PID"
sleep 1
touch "$WORK/active"
fw apply
probe_section() {
	local host="$1" tag="$2" before code
	before="$(wc -l < "$WORK/sections-client.log")"
	code="$(nsenter -t "$LAN" -n curl --silent --show-error --noproxy '*' --max-time 6 --resolve "$host:8080:93.184.216.34" -o /dev/null -w '%{http_code}' "http://$host:8080/")" || {
		cat "$WORK/sections-client.log" "$WORK/vpn1.log" "$WORK/vpn2.log"
		return 1
	}
	test "$code" = 403
	tail -n "+$((before + 1))" "$WORK/sections-client.log" | grep -Eq "device-tproxy (>>|->) $tag]"
}
probe_section exclude.krotex.test direct
probe_section overlap.krotex.test direct
probe_section one.krotex.test section-vpn1
probe_section sub.one.krotex.test section-vpn1
probe_section two.krotex.test section-vpn2
probe_section unmatched.krotex.test section-vpn2
echo 'PASS: HTTP domain rules choose direct, VPN 1 or VPN 2; subdomains and first-match exclusions work'
probe_section allowed.blocked.krotex.test direct
probe_blocked() {
	local host="$1" scheme="$2" port="$3" before
	before="$(wc -l < "$WORK/sections-client.log")"
	if nsenter -t "$LAN" -n curl --silent --show-error --noproxy '*' --max-time 6 --cacert "$WORK/server.crt" --resolve "$host:$port:93.184.216.34" -o /dev/null "$scheme://$host:$port/" 2> "$WORK/block-error"; then
		echo "Blocked domain reached the destination: $host" >&2
		return 1
	fi
	tail -n "+$((before + 1))" "$WORK/sections-client.log" | grep -Eq 'device-tproxy (>>|->) block]'
}
probe_blocked blocked.krotex.test http 8080
probe_blocked sub.blocked.krotex.test http 8080
probe_blocked blocked.krotex.test https 8443
probe_section one.krotex.test section-vpn1
echo 'PASS: Block rejects HTTP, HTTPS and subdomains through real TPROXY while earlier exceptions and other VPN domains remain reachable'

quic_packets() {
	nft list chain inet krotex "$1" | awk '/udp dport 443/ { for (i=1;i<=NF;i++) if ($i == "packets") print $(i+1) }'
}
probe_quic_block() {
	local client="$1" chain="$2" before after
	before="$(quic_packets "$chain")"
	nsenter -t "$client" -n python3 -c 'import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.sendto(b"quic-probe",("93.184.216.34",443)); s.close()'
	after="$(quic_packets "$chain")"
	test "$after" -gt "$before"
}
probe_quic_block "$LAN" device_prerouting
probe_quic_block "$OTHER" section_12084
nsenter -t "$WAN" -n openssl s_server -quiet -www -accept 443 -cert "$WORK/server.crt" -key "$WORK/server.key" > "$WORK/https443.log" 2>&1 &
PIDS="$PIDS $!"
sleep 1
for client in "$LAN" "$OTHER"; do
	code="$(nsenter -t "$client" -n curl --silent --show-error --noproxy '*' --max-time 6 --cacert "$WORK/server.crt" --resolve 'one.krotex.test:443:93.184.216.34' -o /dev/null -w '%{http_code}' https://one.krotex.test/)"
	test "$code" = 200
done
echo 'PASS: UDP/443 is blocked for common and dedicated VPN devices while HTTPS over TCP/443 works'
printf '{"id":"tv"}\n' > "$WORK/profile-probe-request"
ucode package/krotex/files/sections.uc probe "$WORK/core-config.json" "$WORK/profile-probe-request" > "$WORK/profile-probe.json"
python3 tests/sections-traffic.py "$WORK" trust "$WORK/profile-probe.json"
"$XRAY_TEST_BINARY" run -config "$WORK/profile-probe.json" > "$WORK/profile-probe.log" 2>&1 &
PIDS="$PIDS $!"
sleep 1
code="$(curl --silent --show-error --noproxy '' --proxy socks5h://127.0.0.1:11180 --max-time 6 -o /dev/null -w '%{http_code}' http://93.184.216.34:8080/)"
test "$code" = 403
echo 'PASS: the isolated overview probe carries requests through the selected real TLS/VLESS server'



for number in 1 2; do
	port=$((11080 + number))
	before="$(wc -l < "$WORK/sections-client.log")"
	code="$(curl --silent --show-error --noproxy '' --proxy "socks5h://127.0.0.1:$port" --max-time 6 -o /dev/null -w '%{http_code}' http://93.184.216.34:8080/)"
	test "$code" = 403
	tail -n "+$((before + 1))" "$WORK/sections-client.log" | grep -Eq "section-check-vpn$number (>>|->) section-vpn$number]"
done
echo 'PASS: each connection check is isolated to its own VPN even when VPN 2 is the default'
before="$(wc -l < "$WORK/sections-client.log")"
code="$(nsenter -t "$LAN" -n curl --silent --show-error --noproxy '*' --max-time 6 --cacert "$WORK/server.crt" --resolve 'one.krotex.test:8443:93.184.216.34' -o /dev/null -w '%{http_code}' https://one.krotex.test:8443/)"
test "$code" = 200
tail -n "+$((before + 1))" "$WORK/sections-client.log" | grep -Eq 'device-tproxy (>>|->) section-vpn1]'
echo 'PASS: HTTPS SNI selects the domain section through real TPROXY and TLS/VLESS'
before="$(wc -l < "$WORK/sections-client.log")"
code="$(nsenter -t "$LAN" -n curl --silent --show-error --noproxy '*' --max-time 6 -o /dev/null -w '%{http_code}' http://93.184.216.34:8080/)"
test "$code" = 403
tail -n "+$((before + 1))" "$WORK/sections-client.log" | grep -Eq 'device-tproxy (>>|->) section-vpn2]'
before="$(wc -l < "$WORK/sections-client.log")"
timeout 6 nsenter -t "$LAN" -n bash -c 'exec 3<>/dev/udp/93.184.216.34/5353; printf "\x12\x34\x01\x00\x00\x01\x00\x00\x00\x00\x00\x00\x06device\x06krotex\x04test\x00\x00\x01\x00\x01" >&3; dd bs=512 count=1 <&3 2>/dev/null' > "$WORK/section-udp"
tail -c 4 "$WORK/section-udp" | od -An -tu1 | grep -Eq '203[[:space:]]+0[[:space:]]+113[[:space:]]+77'
tail -n "+$((before + 1))" "$WORK/sections-client.log" | grep -Eq 'device-tproxy (>>|->) section-vpn2]'
echo 'PASS: connections without hostnames and non-DNS UDP use the default VPN 2'

kill "$SECTIONS_PID"
wait "$SECTIONS_PID" 2>/dev/null || :
ucode package/krotex/files/sections.uc compile "$WORK/client.json" "$WORK/sections-direct-request.json" > "$WORK/sections-client.json"
python3 tests/sections-traffic.py "$WORK" trust
cp "$WORK/sections-client.json" "$WORK/core-config.json"
"$XRAY_TEST_BINARY" run -config package/krotex/files/transparent.json -config "$WORK/sections-client.json" > "$WORK/sections-client.log" 2>&1 &
PIDS="$PIDS $!"
sleep 1
probe_section unmatched.krotex.test direct
probe_section one.krotex.test section-vpn1
echo 'PASS: without a default VPN, unmatched traffic is direct while listed sites still use VPN 1'


probe_device_vpn() {
	local before code
	before="$(wc -l < "$WORK/sections-client.log")"
	code="$(nsenter -t "$OTHER" -n curl --silent --show-error --noproxy '*' --max-time 6 --resolve 'blocked.krotex.test:8080:93.184.216.34' -o /dev/null -w '%{http_code}' http://blocked.krotex.test:8080/)"
	test "$code" = 403
	tail -n "+$((before + 1))" "$WORK/sections-client.log" | grep -Eq 'device-section-tv (>>|->) section-tv]'
}
probe_device_vpn
before="$(wc -l < "$WORK/sections-client.log")"
nsenter -t "$OTHER" -n "$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" "$RUNTIME/bin/busybox" nslookup -type=A device.krotex.test 192.168.56.1 > "$WORK/device-vpn-dns" 2>&1
grep -q '203.0.113.77' "$WORK/device-vpn-dns"
tail -n "+$((before + 1))" "$WORK/sections-client.log" | grep -Eq 'device-section-tv-dns (>>|->) device-section-tv-dns]'
echo 'PASS: device VPN overrides general Block and captures its own DNS outside the common device list'

printf '{"enabled":true,"mode":"all","macs":[]}\n' > "$WORK/routing.json"
fw apply
probe_device_vpn
printf '{"enabled":false,"mode":"selected","macs":[]}\n' > "$WORK/routing.json"
fw apply
probe_device_vpn
if nsenter -t "$OTHER" -n curl -6 --silent --noproxy '*' --max-time 3 -o /dev/null 'http://[2001:db8:3::1]:8080/'; then
	echo 'FAIL: device VPN leaked over IPv6' >&2; exit 1
fi
code="$(nsenter -t "$OTHER" -n curl --silent --noproxy '*' --max-time 3 -o /dev/null -w '%{http_code}' http://192.168.56.1:8080/)"
test "$code" = 403
echo 'PASS: device VPN works in all and selected-empty modes, blocks IPv6 bypass and keeps router access direct'
probe_quic_block "$OTHER" section_12084
before="$(quic_packets section_12084)"
nsenter -t "$LAN" -n python3 -c 'import socket; s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.sendto(b"not-routed",("93.184.216.34",443)); s.close()'
test "$(quic_packets section_12084)" = "$before"
echo 'PASS: QUIC blocking remains active for dedicated VPNs with common routing disabled and ignores unselected devices'


kill "$VPN1_PID"
wait "$VPN1_PID" 2>/dev/null || :
if nsenter -t "$OTHER" -n curl --silent --noproxy '*' --max-time 3 --resolve 'blocked.krotex.test:8080:93.184.216.34' -o /dev/null http://blocked.krotex.test:8080/; then
	echo 'FAIL: device VPN bypassed its failed server' >&2; exit 1
fi
echo 'PASS: an unavailable device VPN server does not fall back to direct traffic'

if curl --silent --noproxy '' --proxy socks5h://127.0.0.1:11180 --max-time 3 -o /dev/null http://93.184.216.34:8080/; then
	echo 'FAIL: isolated profile check bypassed the failed VPN server' >&2; exit 1
fi
echo 'PASS: the isolated overview probe reports a failed VPN without direct fallback'
