#!/bin/sh
# Run with ash from an extracted OpenWrt x86_64 rootfs; no router is modified.
# OPENWRT_TEST_ROOT=/path/to/rootfs sh tests/connection.test.sh
set -e

: "${OPENWRT_TEST_ROOT:?Set OPENWRT_TEST_ROOT to an extracted OpenWrt x86_64 rootfs}"
RUNTIME="$OPENWRT_TEST_ROOT"
if [ "${KROTEX_TEST_ASH:-0}" != 1 ]; then
	export KROTEX_TEST_ASH=1
	exec "$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" "$RUNTIME/bin/busybox" ash "$0"
fi
cd "$(dirname "$0")/.."
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
trap 'exit 1' HUP INT TERM
TEST_ROOT="$WORK/router"
export TEST_ROOT
mkdir -p "$WORK/bin" "$TEST_ROOT/etc/krotex" "$TEST_ROOT/etc/init.d" "$TEST_ROOT/var/lock"

cat > "$WORK/bin/jshn" <<EOF
#!/bin/sh
exec "$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" "$RUNTIME/usr/bin/jshn" "\$@"
EOF
cat > "$WORK/bin/sleep" <<'EOF'
#!/bin/sh
[ ! -f "$TEST_ROOT/probe-delay" ] || exec /bin/sleep "$@"
exit 0
EOF
cat > "$WORK/bin/ubus" <<'EOF'
#!/bin/sh
if [ -f "$TEST_ROOT/running" ]; then
  echo '{"krotex":{"instances":{"main":{"running":true,"pid":123}}}}'
else
  echo '{}'
fi
EOF
cat > "$WORK/bin/curl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" > "$TEST_ROOT/curl-args"
if [ -f "$TEST_ROOT/fail-request" ]; then
  echo 'curl: (7) Failed to connect to 127.0.0.1 port 10808: Connection refused' >&2
  exit 7
fi
output=
while [ "$#" -gt 0 ]; do
  case "$1" in --output) output=$2; shift ;; esac
  shift
done
if [ -n "$output" ]; then
  echo '203.0.113.25' > "$output"
  if [ -f "$TEST_ROOT/invalid-timing" ]; then echo invalid
  else echo '0.123789'; fi
else echo '203.0.113.25'; fi
EOF
cat > "$TEST_ROOT/xray" <<'EOF'
#!/bin/sh
[ "${0##*/}" != private-xray ] || touch "$TEST_ROOT/private-core-used"
test ! -f "$TEST_ROOT/reject-config" || exit 1
if [ "$2" = -config ]; then echo $$ > "$TEST_ROOT/probe-pid"; cp "$3" "$TEST_ROOT/generated.json"
else cp "$4" "$TEST_ROOT/generated.json"; fi
if [ -n "${XRAY_TEST_BINARY:-}" ]; then
  exec "$XRAY_TEST_BINARY" "$@"
fi
[ "$2" != -config ] || exec /bin/sleep 60
EOF
cat > "$TEST_ROOT/etc/init.d/krotex" <<'EOF'
#!/bin/sh
case "$1" in
  restart)
    rm -f "$TEST_ROOT/running"
    if [ -f "$TEST_ROOT/fail-start" ]; then rm "$TEST_ROOT/fail-start"; exit 1; fi
    touch "$TEST_ROOT/running" ;;
  start) touch "$TEST_ROOT/running" ;;
  stop) rm -f "$TEST_ROOT/running" ;;
esac
EOF
chmod 0755 "$WORK/bin/"* "$TEST_ROOT/xray" "$TEST_ROOT/etc/init.d/krotex"
PATH="$WORK/bin:$PATH"
export PATH
sed -e "s|/usr/share/libubox/jshn.sh|$RUNTIME/usr/share/libubox/jshn.sh|g" \
	-e "s|/etc/krotex/|$TEST_ROOT/etc/krotex/|g" \
	-e "s|/etc/init.d/krotex|$TEST_ROOT/etc/init.d/krotex|g" \
	-e "s|/var/lock/krotex-setup.lock|$TEST_ROOT/var/lock/krotex-setup.lock|g" \
	-e "s|/usr/bin/xray|$TEST_ROOT/xray|g" \
	-e "s|/usr/libexec/krotex/xray|$TEST_ROOT/private-xray|g" \
	-e "s|/usr/share/krotex/transparent.json|$WORK/transparent.json|g" \
	package/luci-app-krotex/root/usr/libexec/krotex/connection > "$WORK/connection"
cp package/krotex/files/transparent.json "$WORK/transparent.json"
. "$RUNTIME/usr/share/libubox/jshn.sh"
JSON_PREFIX=

call() {
	"$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" \
		"$RUNTIME/bin/busybox" ash "$WORK/connection" "$1" < "$WORK/request" > "$WORK/result"
}
expect_code() {
	json_load "$(cat "$WORK/result")"
	json_get_var actual code
	[ "$actual" = "$1" ] || { cat "$WORK/result"; exit 1; }
}
request() {
	json_init
	json_add_string profile "$profile"
	json_dump > "$WORK/request"
}

cp package/krotex/files/config.json "$TEST_ROOT/etc/krotex/config.json"
: > "$WORK/request"
call test_connection
expect_code 1
test ! -f "$TEST_ROOT/curl-args"
echo 'PASS: a direct-only SOCKS listener cannot pass the proxy check'

profile='{"id":"11111111-2222-4333-8444-555555555555","address":"proxy.example","port":443,"security":"reality","server_name":"example.com","fingerprint":"chrome","public_key":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","short_id":"abcdef","spider_x":"/","flow":"xtls-rprx-vision","alpn":""}'
request
call save_connection
expect_code 0
test -f "$TEST_ROOT/running"
json_load "$(cat "$TEST_ROOT/etc/krotex/config.json")"
json_select inbounds; json_select 1; json_get_var listen listen
test "$listen" = 127.0.0.1
json_select ''; json_select outbounds; json_select 1; json_get_var protocol protocol
test "$protocol" = vless
json_select streamSettings; json_select realitySettings; json_get_var key publicKey
test "$key" = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
call connection
json_load "$(cat "$WORK/result")"
json_get_var configured configured
test "$configured" = 1
json_select profile
json_get_var restored_id id
json_get_var restored_key public_key
test "$restored_id" = 11111111-2222-4333-8444-555555555555
test "$restored_key" = AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
echo 'PASS: REALITY config applies and returns the profile for restoring older saved links'

saved_link='vless://11111111-2222-4333-8444-555555555555@proxy.example:443?security=reality&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sni=example.com&fm=ignored#Test%20name'
profile="${profile%?},\"url\":\"$saved_link\"}"
request
call save_connection
expect_code 0
call connection
json_load "$(cat "$WORK/result")"
json_get_var restored_link link
test "$restored_link" = "$saved_link"
echo 'PASS: original VLESS link survives saving and reopening, including unknown parameters and label'

cp "$TEST_ROOT/etc/krotex/config.json" "$WORK/saved.json"
touch "$TEST_ROOT/reject-config"
call save_connection
expect_code 1
cmp "$WORK/saved.json" "$TEST_ROOT/etc/krotex/config.json"
test -f "$TEST_ROOT/running"
rm "$TEST_ROOT/reject-config"
echo 'PASS: core validation failure leaves config and running process unchanged'

touch "$TEST_ROOT/fail-start"
call save_connection
expect_code 1
cmp "$WORK/saved.json" "$TEST_ROOT/etc/krotex/config.json"
test -f "$TEST_ROOT/running"
test ! -d "$TEST_ROOT/var/lock/krotex-setup.lock"
echo 'PASS: startup failure restores previous config and service'

rm "$TEST_ROOT/running"
touch "$TEST_ROOT/fail-start"
call save_connection
expect_code 1
cmp "$WORK/saved.json" "$TEST_ROOT/etc/krotex/config.json"
test ! -f "$TEST_ROOT/running"
echo 'PASS: failed application preserves a previously stopped service'

mkdir "$TEST_ROOT/var/lock/krotex-setup.lock"
call save_connection
expect_code 1
test -d "$TEST_ROOT/var/lock/krotex-setup.lock"
cmp "$WORK/saved.json" "$TEST_ROOT/etc/krotex/config.json"
rmdir "$TEST_ROOT/var/lock/krotex-setup.lock"
echo 'PASS: concurrent operations are rejected without releasing another operation lock'

profile="$(printf '%s' "$profile" | sed 's/"security":"reality"/"security":"tls"/; s/"alpn":""/"alpn":"h2,http\/1.1"/')"
request
call save_connection
expect_code 0
json_load "$(cat "$TEST_ROOT/etc/krotex/config.json")"
json_select outbounds; json_select 1; json_select streamSettings
json_get_var security security
test "$security" = tls
json_select tlsSettings; json_select alpn; json_get_var alpn 2
test "$alpn" = http/1.1
call connection
json_load "$(cat "$WORK/result")"
json_select profile
json_get_var restored_alpn alpn
json_get_var restored_sni server_name
test "$restored_alpn" = h2,http/1.1
test "$restored_sni" = example.com
echo 'PASS: TLS configuration includes ALPN'

cp "$TEST_ROOT/xray" "$TEST_ROOT/private-xray"
call save_connection
expect_code 0
test -f "$TEST_ROOT/private-core-used"
rm "$TEST_ROOT/private-xray"
echo 'PASS: connection validation uses the private core when installed'

call test_connection
expect_code 0
grep -q 'socks5h://127.0.0.1:10808' "$TEST_ROOT/curl-args"
grep -q -- '--noproxy' "$TEST_ROOT/curl-args"
touch "$TEST_ROOT/fail-request"
call test_connection
expect_code 1
json_get_var curl_code curl_code
test "$curl_code" = 7
json_get_var error_message message
case "$error_message" in *'Connection refused'*) ;; *) echo 'FAIL: curl error details were lost'; exit 1 ;; esac
echo 'PASS: network check uses SOCKS with remote DNS and reports request failures'

profile="$(printf '%s' "$profile" | sed 's/"port":443/"port":"443"/')"
request
cp "$TEST_ROOT/etc/krotex/config.json" "$WORK/saved.json"
call save_connection
expect_code 1
cmp "$WORK/saved.json" "$TEST_ROOT/etc/krotex/config.json"
echo 'PASS: backend rejects invalid field types independently of the browser'

sed -e "s|/usr/share/libubox/jshn.sh|$RUNTIME/usr/share/libubox/jshn.sh|g" \
	-e "s|/usr/share/krotex/version|$TEST_ROOT/usr/share/krotex/version|g" \
	-e "s|/etc/krotex/source-version|$TEST_ROOT/etc/krotex/source-version|g" \
	-e "s|/etc/init.d/krotex|$TEST_ROOT/etc/init.d/krotex|g" \
	-e "s|/usr/bin/xray|$TEST_ROOT/xray|g" \
	package/luci-app-krotex/root/usr/libexec/rpcd/krotex > "$WORK/rpc"
mkdir -p "$TEST_ROOT/usr/share/krotex"
printf '0.8.1\n' > "$TEST_ROOT/usr/share/krotex/version"
rm "$TEST_ROOT/running"
"$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" \
	"$RUNTIME/bin/busybox" ash "$WORK/rpc" call status > "$WORK/result"
json_load "$(cat "$WORK/result")"
json_get_var active running
test "$active" = 0
json_get_var krotex_version krotex_version
test "$krotex_version" = 0.8.1
! grep -q WARNING "$WORK/result"
echo 'PASS: stopped-service RPC status stays valid JSON on OpenWrt 24.10 jshn'

cp package/krotex/files/routing.json "$WORK/routing.json"
cat > "$WORK/firewall" <<EOF
#!/bin/sh
case "\$1" in
  status) test -f "$WORK/routing-active" ;;
  apply|start)
    if [ -f "$WORK/routing-fail" ]; then rm "$WORK/routing-fail"; exit 1; fi
    if grep -Eq '"enabled"[[:space:]]*:[[:space:]]*true' "$WORK/routing.json"; then
      touch "$WORK/routing-active"
    else rm -f "$WORK/routing-active"; fi ;;
esac
EOF
chmod 0755 "$WORK/firewall"
sed -e "s|/usr/share/libubox/jshn.sh|$RUNTIME/usr/share/libubox/jshn.sh|g" \
	-e "s|/etc/krotex/routing.json|$WORK/routing.json|g" \
	-e "s|/etc/krotex/config.json|$TEST_ROOT/etc/krotex/config.json|g" \
	-e "s|/usr/libexec/krotex/firewall|$WORK/firewall|g" \
	-e "s|/var/lock/krotex-setup.lock|$TEST_ROOT/var/lock/krotex-setup.lock|g" \
	-e "s|/var/run/krotex/routing-service-active|$WORK/service-active|g" \
	-e "s|/etc/krotex/.routing.|$TEST_ROOT/etc/krotex/.routing.|g" \
	-e "s|/tmp/dhcp.leases|$WORK/leases|g" \
	package/luci-app-krotex/root/usr/libexec/krotex/routing > "$WORK/routing"
call_routing() {
	"$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" \
		"$RUNTIME/bin/busybox" ash "$WORK/routing" "$1" < "$WORK/request" > "$WORK/result"
}
printf '0 02:11:22:33:44:55 192.168.1.10 phone *\n0 invalid 192.168.1.11 invalid *\n' > "$WORK/leases"
call_routing devices
json_load "$(cat "$WORK/result")"
json_select devices; json_get_keys keys
set -- $keys
test "$#" -eq 1 && test "$1" = 1
echo 'PASS: DHCP discovery returns valid devices and skips malformed MAC addresses'

printf '{"enabled":true,"mac":"02:11:22:33:44:55"}\n' > "$WORK/request"
call_routing set_routing
expect_code 1
touch "$WORK/service-active"
call_routing set_routing
expect_code 0
test -f "$WORK/routing-active"
cp "$WORK/routing.json" "$WORK/routing-previous"
printf '{"enabled":true,"mac":"ff:ff:ff:ff:ff:ff"}\n' > "$WORK/request"
call_routing set_routing
expect_code 1
cmp "$WORK/routing-previous" "$WORK/routing.json"
echo 'PASS: routing requires a running service and rejects broadcast MACs'

printf '{"enabled":true,"mac":"02:11:22:33:44:55"}\n' > "$WORK/routing.json"
printf '{"enabled":true,"mac":"02:aa:bb:cc:dd:ee"}\n' > "$WORK/request"
call_routing set_routing
expect_code 0
call_routing routing
json_load "$(cat "$WORK/result")"
json_select macs; json_get_var first 1; json_get_var second 2
test "$first" = 02:11:22:33:44:55
test "$second" = 02:aa:bb:cc:dd:ee
call_routing set_routing
expect_code 0
json_load "$(cat "$WORK/routing.json")"
json_select macs; json_get_keys keys
set -- $keys
test "$#" -eq 2
cp "$WORK/routing.json" "$WORK/routing-previous"
echo 'PASS: legacy single-device settings migrate on add, preserving both devices without duplicates'

printf '{"mode":"all"}\n' > "$WORK/request"
call_routing set_routing_mode
expect_code 0
call_routing routing
json_load "$(cat "$WORK/result")"
json_get_var mode mode
json_get_var enabled enabled
test "$mode" = all && test "$enabled" = 1
json_select macs; json_get_var first 1; json_get_var second 2
test "$first" = 02:11:22:33:44:55 && test "$second" = 02:aa:bb:cc:dd:ee
cp "$WORK/routing.json" "$WORK/all-previous"
touch "$WORK/routing-fail"
printf '{"mode":"selected"}\n' > "$WORK/request"
call_routing set_routing_mode
expect_code 1
cmp "$WORK/all-previous" "$WORK/routing.json"
call_routing set_routing_mode
expect_code 0
json_load "$(cat "$WORK/routing.json")"
json_get_var mode mode
test "$mode" = selected
cp "$WORK/routing.json" "$WORK/routing-previous"
echo 'PASS: mode switching preserves selected MACs and failed changes roll back'

touch "$WORK/routing-fail"
printf '{"enabled":true,"mac":"02:66:77:88:99:aa"}\n' > "$WORK/request"
call_routing set_routing
expect_code 1
cmp "$WORK/routing-previous" "$WORK/routing.json"
test -f "$WORK/routing-active"
echo 'PASS: firewall failure restores previous routing settings'

rm "$WORK/service-active"
printf '{"enabled":false,"mac":"02:11:22:33:44:55"}\n' > "$WORK/request"
call_routing set_routing
expect_code 0
json_load "$(cat "$WORK/routing.json")"
json_select macs; json_get_var remaining 1; json_get_keys keys
test "$remaining" = 02:aa:bb:cc:dd:ee
set -- $keys
test "$#" -eq 1
echo 'PASS: removing one device preserves the other even while the service is stopped'

printf '{"enabled":false,"mac":""}\n' > "$WORK/request"
call_routing set_routing
expect_code 0
test ! -f "$WORK/routing-active"
echo 'PASS: device routing can be disabled even when the service is stopped'
printf '{"mode":"all"}\n' > "$WORK/request"
call_routing set_routing_mode
expect_code 1
echo 'PASS: enabling routing for all devices requires the running service'

cat > "$WORK/bin/ucode" <<EOF
#!/bin/sh
exec "$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" "$RUNTIME/usr/bin/ucode" -L "$RUNTIME/usr/lib/ucode" "\$@"
EOF
chmod 0755 "$WORK/bin/ucode"
sed -e "s|/usr/share/libubox/jshn.sh|$RUNTIME/usr/share/libubox/jshn.sh|g" \
	-e "s|/etc/krotex/|$TEST_ROOT/etc/krotex/|g" \
	-e "s|/etc/init.d/krotex|$TEST_ROOT/etc/init.d/krotex|g" \
	-e "s|/usr/bin/xray|$TEST_ROOT/xray|g" \
	-e "s|/usr/libexec/krotex/xray|$TEST_ROOT/private-xray|g" \
	-e "s|/var/lock/krotex-setup.lock|$TEST_ROOT/var/lock/krotex-setup.lock|g" \
	-e "s|$TEST_ROOT/etc/krotex/routing.json|$WORK/routing.json|g" \
	-e "s|/usr/libexec/krotex/firewall|$WORK/firewall|g" \
	-e "s|/usr/share/krotex/sections.uc|$(pwd)/package/krotex/files/sections.uc|g" \
	-e "s|/usr/share/krotex/transparent.json|$WORK/transparent.json|g" \
	package/luci-app-krotex/root/usr/libexec/krotex/sections > "$WORK/sections"
call_sections() {
	"$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" \
		"$RUNTIME/bin/busybox" ash "$WORK/sections" "$1" < "$WORK/request" > "$WORK/result"
}
section_request() {
	json_init; json_add_string sections "$sections"; json_dump > "$WORK/request"
}
call_sections sections
json_load "$(cat "$WORK/result")"
json_select sections; json_select 1; json_get_var fallback fallback
test "$fallback" = 1
echo 'PASS: section API imports the existing connection without changing its configuration'

profile="$(printf '%s' "$profile" | sed 's/"port":"443"/"port":443/')"
sections="[{\"id\":\"exclude\",\"name\":\"exclude\",\"mode\":\"direct\",\"enabled\":true,\"fallback\":false,\"domains\":[\"example.com\"]},{\"id\":\"vpn1\",\"name\":\"VPN 1\",\"mode\":\"proxy\",\"enabled\":true,\"fallback\":false,\"domains\":[\"one.test\"],\"profile\":$profile},{\"id\":\"vpn2\",\"name\":\"VPN 2\",\"mode\":\"proxy\",\"enabled\":true,\"fallback\":true,\"domains\":[],\"profile\":$profile}]"
section_request
call_sections save_sections
expect_code 0
test -f "$TEST_ROOT/running"
cp "$TEST_ROOT/etc/krotex/config.json" "$WORK/sections-saved"
call_sections sections
json_load "$(cat "$WORK/result")"
json_select sections; json_get_keys keys
set -- $keys
test "$#" -eq 3
echo 'PASS: section API saves exclude and two independent VPN sections atomically'

rm -f "$TEST_ROOT/fail-request" "$TEST_ROOT/curl-args"
printf '{"id":"vpn2"}\n' > "$WORK/request"
call_sections test_section
expect_code 0
grep -q 'socks5h://127.0.0.1:11082' "$TEST_ROOT/curl-args"
grep -q 'time_starttransfer' "$TEST_ROOT/curl-args"
json_get_var latency_ms latency_ms
json_get_var ip ip
test "$latency_ms" = 124 && test "$ip" = 203.0.113.25
touch "$TEST_ROOT/invalid-timing"
call_sections test_section
expect_code 1
rm "$TEST_ROOT/invalid-timing"
echo 'PASS: section checks return rounded HTTPS latency and preserve the exit IP'

rm "$TEST_ROOT/curl-args"
printf '{"id":"exclude"}\n' > "$WORK/request"
call_sections test_section
expect_code 1
test ! -f "$TEST_ROOT/curl-args"
echo 'PASS: a section check uses its own proxy listener and rejects direct sections'

request
call save_connection
expect_code 1
cmp "$WORK/sections-saved" "$TEST_ROOT/etc/krotex/config.json"
echo 'PASS: the legacy connection API cannot overwrite saved sections'

section_request
touch "$TEST_ROOT/reject-config"
call_sections save_sections
expect_code 1
cmp "$WORK/sections-saved" "$TEST_ROOT/etc/krotex/config.json"
rm "$TEST_ROOT/reject-config"
touch "$TEST_ROOT/fail-start"
call_sections save_sections
expect_code 1
cmp "$WORK/sections-saved" "$TEST_ROOT/etc/krotex/config.json"
test -f "$TEST_ROOT/running"
mkdir "$TEST_ROOT/var/lock/krotex-setup.lock"
call_sections save_sections
expect_code 1
test -d "$TEST_ROOT/var/lock/krotex-setup.lock"
rmdir "$TEST_ROOT/var/lock/krotex-setup.lock"
echo 'PASS: rejected sections, failed startup and concurrent updates preserve the saved configuration'

sections='[]'
section_request
call_sections save_sections
expect_code 0
touch "$WORK/service-active"
printf '{"enabled":true,"mac":"02:11:22:33:44:55"}\n' > "$WORK/request"
call_routing set_routing
expect_code 0
echo 'PASS: devices can use domain sections with a direct-only default and no VPN'

sections='[{"id":"draft","name":"New section","mode":"unconfigured","enabled":false,"fallback":false,"domains":[]}]'
section_request
call_sections save_sections
expect_code 0
call_sections sections
json_load "$(cat "$WORK/result")"
json_select sections; json_select 1
json_get_var mode mode
json_get_var enabled enabled
test "$mode" = unconfigured
test "$enabled" = 0
printf '{"id":"draft"}\n' > "$WORK/request"
call_sections test_section
expect_code 1
echo 'PASS: an unconfigured section saves and reopens without creating a usable VPN route'

printf '{"enabled":false,"mac":""}\n' > "$WORK/request"
call_routing set_routing
expect_code 0
printf '{"mode":"all"}\n' > "$WORK/request"
call_routing set_routing_mode
expect_code 0
test -f "$WORK/routing-active"
cp "$WORK/routing.json" "$WORK/all-previous"
printf '{"mode":"wan"}\n' > "$WORK/request"
call_routing set_routing_mode
expect_code 1
cmp "$WORK/all-previous" "$WORK/routing.json"
printf '{"mode":"selected"}\n' > "$WORK/request"
call_routing set_routing_mode
expect_code 0
test ! -f "$WORK/routing-active"
echo 'PASS: all-device mode works with an empty selection and rejects invalid modes'
printf '{"mode":"all"}\n' > "$WORK/request"
call_routing set_routing_mode
expect_code 0
printf '{"enabled":false,"mac":""}\n' > "$WORK/request"
call_routing set_routing
expect_code 0
test ! -f "$WORK/routing-active"
printf '{"enabled":false,"mode":"all","macs":[]}\n' > "$WORK/routing.json"
call_routing routing
json_load "$(cat "$WORK/result")"
json_get_var enabled enabled
test "$enabled" = 0
echo 'PASS: legacy disable also stops all-device routing and disabled status remains accurate'


# The page sends one transaction for sections and the entire routing scope.
settings_request() {
	json_init
	json_add_string sections "$sections"
	json_add_string routing "$routing"
	json_dump > "$WORK/request"
}
sections='[{"id":"direct","name":"Direct","mode":"direct","enabled":true,"fallback":true,"domains":["example.com"]}]'
routing='{"mode":"all","macs":["02:AA:BB:CC:DD:EE","02:aa:bb:cc:dd:ee"]}'
settings_request
call_sections save_settings
expect_code 0
json_load "$(cat "$WORK/routing.json")"
json_get_var mode mode
json_get_var enabled enabled
test "$mode" = all && test "$enabled" = 1
json_select macs; json_get_keys keys; set -- $keys
test "$#" -eq 1
json_get_var mac 1; test "$mac" = 02:aa:bb:cc:dd:ee
test -f "$WORK/routing-active"
cp "$TEST_ROOT/etc/krotex/config.json" "$WORK/settings-core"
cp "$WORK/routing.json" "$WORK/settings-routing"
echo 'PASS: unified settings save validates and applies sections, mode and normalized device list'

sections='[]'
for routing in '{"mode":"wan","macs":[]}' '{"mode":"selected","macs":["01:11:22:33:44:55"]}' '{"mode":"all","macs":["00:00:00:00:00:00"]}' '{"mode":"selected","macs":"invalid"}'; do
	settings_request; call_sections save_settings; expect_code 1
	cmp "$WORK/settings-core" "$TEST_ROOT/etc/krotex/config.json"
	cmp "$WORK/settings-routing" "$WORK/routing.json"
done
echo 'PASS: invalid routing leaves both saved configurations unchanged'

routing='{"mode":"selected","macs":[]}'
settings_request
touch "$TEST_ROOT/fail-start"
call_sections save_settings; expect_code 1
cmp "$WORK/settings-core" "$TEST_ROOT/etc/krotex/config.json"
cmp "$WORK/settings-routing" "$WORK/routing.json"
test -f "$TEST_ROOT/running"
touch "$WORK/routing-fail"
call_sections save_settings; expect_code 1
cmp "$WORK/settings-core" "$TEST_ROOT/etc/krotex/config.json"
cmp "$WORK/settings-routing" "$WORK/routing.json"
test -f "$TEST_ROOT/running"
echo 'PASS: startup and firewall failures roll back sections and routing together'

call_sections save_settings; expect_code 0
test ! -f "$WORK/routing-active"
json_load "$(cat "$WORK/routing.json")"; json_get_var enabled enabled
test "$enabled" = 0
echo 'PASS: unified save can clear sections and disable all device routing together'


sections='[{"id":"deny","name":"Blocked sites","mode":"block","enabled":true,"fallback":false,"domains":["blocked.example"]}]'
routing='{"mode":"selected","macs":[]}'
settings_request
call_sections save_settings; expect_code 0
call_sections sections
json_load "$(cat "$WORK/result")"; json_select sections; json_select 1; json_get_var mode mode
test "$mode" = block
printf '{"id":"deny"}\n' > "$WORK/request"
call_sections test_section; expect_code 1
echo 'PASS: unified settings saves and reopens Block without VLESS and rejects proxy checks on it'


sections='[{"id":"deny","name":"Blocked sites","mode":"block","enabled":true,"fallback":false,"domains":["ignored.example"],"domains_text":"#ip-api.com\nexample.com"}]'
settings_request
call_sections save_settings; expect_code 0
call_sections sections
json_load "$(cat "$WORK/result")"; json_select sections; json_select 1
json_get_var domain_text domains_text
test "$domain_text" = "$(printf '#ip-api.com\nexample.com')"
json_select domains; json_get_var domain 1
test "$domain" = example.com
json_load "$(cat "$TEST_ROOT/etc/krotex/config.json")"; json_select routing; json_select rules; json_select 2; json_select domain; json_get_var domain 1
test "$domain" = domain:example.com
echo 'PASS: unified save preserves commented domain text while Xray only receives active domains'


sections="[{\"id\":\"tv\",\"name\":\"TV VPN\",\"mode\":\"proxy_devices\",\"enabled\":true,\"fallback\":false,\"domains\":[],\"macs\":[\"02:11:22:33:44:55\"],\"profile\":$profile}]"
settings_request
call_sections save_settings; expect_code 0
call_sections sections
json_load "$(cat "$WORK/result")"; json_select sections; json_select 1
json_get_var mode mode; test "$mode" = proxy_devices
json_select macs; json_get_var mac 1; test "$mac" = 02:11:22:33:44:55
printf '{"id":"tv"}\n' > "$WORK/request"
call_sections test_section; expect_code 0
cp "$TEST_ROOT/etc/krotex/config.json" "$WORK/device-saved"
sections="$(printf '%s' "$sections" | sed 's/"fallback":false/"fallback":true/')"
settings_request
call_sections save_settings; expect_code 1
cmp "$WORK/device-saved" "$TEST_ROOT/etc/krotex/config.json"
echo 'PASS: unified settings persists device VPNs, supports their connection checks and rejects an invalid general default'


sections="[{\"id\":\"inactive\",\"name\":\"Inactive VPN\",\"mode\":\"proxy\",\"enabled\":false,\"fallback\":false,\"domains\":[],\"profile\":$profile}]"
settings_request
call_sections save_settings; expect_code 0
cp "$TEST_ROOT/etc/krotex/config.json" "$WORK/probe-previous"
rm -f "$TEST_ROOT/running"
call_sections connections
json_load "$(cat "$WORK/result")"; json_select connections; json_select 1; json_get_var id id
test "$id" = inactive
printf '{"id":"inactive"}\n' > "$WORK/request"
touch "$TEST_ROOT/probe-delay"
call_sections test_profile; expect_code 0
grep -q 'socks5h://127.0.0.1:11180' "$TEST_ROOT/curl-args"
test ! -f "$TEST_ROOT/running"
cmp "$WORK/probe-previous" "$TEST_ROOT/etc/krotex/config.json"
! kill -0 "$(cat "$TEST_ROOT/probe-pid")" 2>/dev/null
touch "$TEST_ROOT/fail-request"
call_sections test_profile; expect_code 1
! kill -0 "$(cat "$TEST_ROOT/probe-pid")" 2>/dev/null
rm "$TEST_ROOT/fail-request" "$TEST_ROOT/probe-delay"
cmp "$WORK/probe-previous" "$TEST_ROOT/etc/krotex/config.json"
printf '{"id":"missing"}\n' > "$WORK/request"
call_sections test_profile; expect_code 1
echo 'PASS: inactive connection checks work with the service stopped, preserve configuration and clean up temporary Xray on success and failure'
