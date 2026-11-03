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
echo '203.0.113.25'
EOF
cat > "$TEST_ROOT/xray" <<'EOF'
#!/bin/sh
[ "${0##*/}" != private-xray ] || touch "$TEST_ROOT/private-core-used"
test ! -f "$TEST_ROOT/reject-config" || exit 1
cp "$4" "$TEST_ROOT/generated.json"
if [ -n "${XRAY_TEST_BINARY:-}" ]; then
  exec "$XRAY_TEST_BINARY" "$@"
fi
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
	-e "s|/etc/init.d/krotex|$TEST_ROOT/etc/init.d/krotex|g" \
	-e "s|/usr/bin/xray|$TEST_ROOT/xray|g" \
	package/luci-app-krotex/root/usr/libexec/rpcd/krotex > "$WORK/rpc"
rm "$TEST_ROOT/running"
"$RUNTIME/lib/ld-musl-x86_64.so.1" --library-path "$RUNTIME/lib:$RUNTIME/usr/lib" \
	"$RUNTIME/bin/busybox" ash "$WORK/rpc" call status > "$WORK/result"
json_load "$(cat "$WORK/result")"
json_get_var active running
test "$active" = 0
! grep -q WARNING "$WORK/result"
echo 'PASS: stopped-service RPC status stays valid JSON on OpenWrt 24.10 jshn'

cp package/krotex/files/routing.json "$WORK/routing.json"
cat > "$WORK/firewall" <<EOF
#!/bin/sh
case "\$1" in
  status) test -f "$WORK/routing-active" ;;
  apply)
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
