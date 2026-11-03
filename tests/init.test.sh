#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
. ./package/krotex/files/krotex.init

test_dir="$(mktemp -d)"
trap 'rm -f "$test_dir/xray" "$test_dir/config.json" "$test_dir/events"; rmdir "$test_dir"' EXIT
PROG="$test_dir/xray"
CONF="$test_dir/config.json"
EVENTS="$test_dir/events"
export EVENTS
printf '{}\n' > "$CONF"
cat > "$PROG" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$EVENTS"
exit "${XRAY_TEST_EXIT:-0}"
EOF
chmod 0755 "$PROG"

procd_open_instance() { printf 'instance %s\n' "$*" >> "$EVENTS"; }
procd_set_param() { printf 'param %s\n' "$*" >> "$EVENTS"; }
procd_close_instance() { printf 'close\n' >> "$EVENTS"; }

XRAY_TEST_EXIT=1
export XRAY_TEST_EXIT
if start_service; then
  echo 'FAIL: invalid config was accepted' >&2
  exit 1
fi
if grep -q '^instance' "$EVENTS"; then
  echo 'FAIL: procd instance created for invalid config' >&2
  exit 1
fi

XRAY_TEST_EXIT=0
: > "$EVENTS"
start_service
grep -q '^instance main$' "$EVENTS"
grep -q '^param command .* run -config ' "$EVENTS"
grep -q '^param respawn 3600 5 5$' "$EVENTS"
grep -q '^close$' "$EVENTS"
echo 'PASS: config validation and procd registration'
