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
test ! -f "$TEST_ROOT/fail-request" || exit 7
echo '203.0.113.25'
EOF
cat > "$TEST_ROOT/xray" <<'EOF'
#!/bin/sh
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
	package/luci-app-krotex/root/usr/libexec/krotex/connection > "$WORK/connection"
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
! grep -q '11111111\|AAAAAAAAA' "$WORK/result"
echo 'PASS: REALITY config applies and read-only summary contains no credentials'

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
echo 'PASS: TLS configuration includes ALPN'

call test_connection
expect_code 0
grep -q 'socks5h://127.0.0.1:10808' "$TEST_ROOT/curl-args"
grep -q -- '--noproxy' "$TEST_ROOT/curl-args"
touch "$TEST_ROOT/fail-request"
call test_connection
expect_code 1
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
