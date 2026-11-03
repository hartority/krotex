#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
PROJECT="$(pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
trap 'exit 1' HUP INT TERM
TEST_ROOT="$WORK/router"
export TEST_ROOT
TEST_TAR="$(command -v tar)"
export TEST_TAR
mkdir -p "$WORK/source" "$WORK/bin" "$TEST_ROOT/etc/init.d" \
	"$TEST_ROOT/usr/bin" "$TEST_ROOT/usr/share/libubox"
cp -R package "$WORK/source/"
cp update.sh "$WORK/source/"
sed "s|^SYSROOT=\$|SYSROOT=$TEST_ROOT|" install.sh > "$WORK/source/install.sh"
touch "$TEST_ROOT/etc/openwrt_release"

cat > "$WORK/bin/id" <<'EOF'
#!/bin/sh
echo 0
EOF
cat > "$WORK/bin/opkg" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$WORK/bin/ubus" <<'EOF'
#!/bin/sh
echo '{}'
EOF
cat > "$WORK/bin/sleep" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$WORK/bin/tar" <<'EOF'
#!/bin/sh
# Model OpenWrt's minimal BusyBox tar, which has no GNU long options.
for arg in "$@"; do
  case "$arg" in
    --*) printf 'tar: unrecognized option: %s\n' "${arg#--}" >&2; exit 1 ;;
  esac
done
exec "$TEST_TAR" "$@"
EOF
cat > "$TEST_ROOT/usr/share/libubox/jshn.sh" <<'EOF'
json_load() { return 0; }
json_select() { test -f "$TEST_ROOT/running"; }
json_get_var() { running=1; }
EOF
cat > "$TEST_ROOT/usr/bin/xray" <<'EOF'
#!/bin/sh
test ! -f "$TEST_ROOT/invalid-config"
EOF
cat > "$TEST_ROOT/etc/init.d/rpcd" <<'EOF'
#!/bin/sh
if [ -f "$TEST_ROOT/fail-rpcd" ]; then
  rm "$TEST_ROOT/fail-rpcd"
  exit 1
fi
EOF
cat > "$WORK/source/package/krotex/files/krotex.init" <<'EOF'
#!/bin/sh
case "$1" in
  enabled) test -f "$TEST_ROOT/enabled" ;;
  enable) touch "$TEST_ROOT/enabled" ;;
  disable) rm -f "$TEST_ROOT/enabled" ;;
  start) touch "$TEST_ROOT/running" ;;
  stop) rm -f "$TEST_ROOT/running" ;;
  *) exit 1 ;;
esac
EOF
chmod 0755 "$WORK/bin/"* "$TEST_ROOT/usr/bin/xray" "$TEST_ROOT/etc/init.d/rpcd"
PATH="$WORK/bin:$PATH"
export PATH

sh "$WORK/source/install.sh" > "$WORK/install.log" 2>&1 || { cat "$WORK/install.log"; exit 1; }
test -f "$TEST_ROOT/running"
test -f "$TEST_ROOT/enabled"
test -x "$TEST_ROOT/usr/libexec/rpcd/krotex"
test -x "$TEST_ROOT/usr/libexec/krotex/connection"
test -f "$TEST_ROOT/www/luci-static/resources/krotex/vless.js"
test -f "$TEST_ROOT/www/luci-static/resources/view/krotex/status.js"
grep -qxF '/etc/krotex/' "$TEST_ROOT/etc/sysupgrade.conf"
echo 'PASS: first installation deploys files and enables/starts the service'

printf '{"custom":true}\n' > "$TEST_ROOT/etc/krotex/config.json"
rm "$TEST_ROOT/running" "$TEST_ROOT/enabled"
sh "$WORK/source/update.sh" > "$WORK/update.log" 2>&1 || { cat "$WORK/update.log"; exit 1; }
test ! -f "$TEST_ROOT/running"
test ! -f "$TEST_ROOT/enabled"
grep -q '"custom":true' "$TEST_ROOT/etc/krotex/config.json"
test "$(grep -cxF '/etc/krotex/' "$TEST_ROOT/etc/sysupgrade.conf")" -eq 1
echo 'PASS: update preserves custom config and stopped/disabled state'

touch "$TEST_ROOT/running" "$TEST_ROOT/enabled" "$TEST_ROOT/invalid-config"
if sh "$WORK/source/update.sh" > "$WORK/invalid.log" 2>&1; then
  echo 'FAIL: invalid config accepted' >&2
  exit 1
fi
test -f "$TEST_ROOT/running"
rm "$TEST_ROOT/invalid-config"
echo 'PASS: invalid config aborts before stopping the service'

cp "$TEST_ROOT/etc/init.d/krotex" "$WORK/previous.init"
printf '\n# New version\n' >> "$WORK/source/package/krotex/files/krotex.init"
touch "$TEST_ROOT/fail-rpcd"
if sh "$WORK/source/update.sh" > "$WORK/rollback.log" 2>&1; then
  echo 'FAIL: rpcd failure ignored' >&2
  exit 1
fi
cmp "$WORK/previous.init" "$TEST_ROOT/etc/init.d/krotex"
test -f "$TEST_ROOT/running"
test -f "$TEST_ROOT/enabled"
grep -q '"custom":true' "$TEST_ROOT/etc/krotex/config.json"
test ! -d "$TEST_ROOT/var/lock/krotex-setup.lock"
echo 'PASS: deployment failure restores previous files and service state'

# Exercise GitHub archive bootstrap without making network requests.
tar -czf "$WORK/source.tar.gz" -C "$WORK" source
TEST_ARCHIVE="$WORK/source.tar.gz"
TEST_INSTALLER="$WORK/source/install.sh"
export TEST_ARCHIVE TEST_INSTALLER
cat > "$WORK/bin/curl" <<'EOF'
#!/bin/sh
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; destination=$1 ;;
    https://*) url=$1 ;;
  esac
  shift
done
case "$url" in
  https://raw.githubusercontent.com/*)
    printf '%s\n' "$url" > "$TEST_ROOT/installer-url"
    cp "$TEST_INSTALLER" "$destination" ;;
  *)
    printf '%s\n' "$url" > "$TEST_ROOT/download-url"
    cp "$TEST_ARCHIVE" "$destination" ;;
esac
EOF
chmod 0755 "$WORK/bin/curl"
sh "$WORK/source/update.sh" --ref v0.1.0 > "$WORK/download.log" 2>&1 || { cat "$WORK/download.log"; exit 1; }
grep -qxF 'https://codeload.github.com/hartority/krotex/tar.gz/v0.1.0' "$TEST_ROOT/download-url"
grep -qxF 'ref=v0.1.0' "$TEST_ROOT/etc/krotex/source-version"
test -f "$TEST_ROOT/running"
echo 'PASS: GitHub archive bootstrap supports an explicit ref'

mkdir "$WORK/bootstrap"
cp update.sh "$WORK/bootstrap/update.sh"
sh "$WORK/bootstrap/update.sh" --ref v0.2.0 > "$WORK/bootstrap.log" 2>&1 || { cat "$WORK/bootstrap.log"; exit 1; }
grep -qxF 'https://raw.githubusercontent.com/hartority/krotex/v0.2.0/install.sh' "$TEST_ROOT/installer-url"
grep -qxF 'https://codeload.github.com/hartority/krotex/tar.gz/v0.2.0' "$TEST_ROOT/download-url"
echo 'PASS: standalone updater pins both installer and source to the requested ref'

rm "$WORK/bin/opkg"
cat > "$WORK/bin/apk" <<'EOF'
#!/bin/sh
case "$1" in
  info) exit 1 ;;
  update|add) exit 0 ;;
  *) exit 1 ;;
esac
EOF
chmod 0755 "$WORK/bin/apk"
sh "$WORK/source/update.sh" > "$WORK/apk.log" 2>&1 || { cat "$WORK/apk.log"; exit 1; }
test -f "$TEST_ROOT/running"
echo 'PASS: apk dependency installation path'
