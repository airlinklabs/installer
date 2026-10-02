#!/usr/bin/env bash
#==============================================================================
# e2e.sh - hermetic end-to-end checks (docs/spec.md §13)
#
# Nothing outside a throwaway $TMP ever runs: throwaway HOME, AIRLINK_* dir
# overrides pointing into $TMP, a fake os-release, and PATH stubs for every
# privileged/system command (they only log their argv). Runs as the invoking
# user - the stubbed `sudo` covers the TS side's `sudo -n` local-dev path.
#
# Scenarios: --help 0; plain-no-action 2; unknown flag 2; uninstall w/o --yes 2;
# demo 0 with checkmarks and zero system changes; bootstrap smoke over file://
# (platform detect -> download -> verbatim flags -> checksum -> rc propagation,
# including checksum-mismatch death).
#==============================================================================
set -euo pipefail
cd "$(dirname "$0")"                       # installer/
BOOTSTRAP="../installer.sh"                # repo root

TMP="$(mktemp -d /tmp/airlink-e2e.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok  $*"; }

# --- hermetic sandbox --------------------------------------------------------
export HOME="$TMP/home"
mkdir -p "$HOME" "$TMP/panel" "$TMP/daemon" "$TMP/units" "$TMP/bin" "$TMP/fixtures"
: > "$TMP/stub.log"

cat > "$TMP/os-release" <<'EOF'
ID=ubuntu
VERSION_ID="24.04"
PRETTY_NAME="Ubuntu 24.04 LTS"
EOF

# every privileged/system command logs instead of acting
for cmd in sudo systemctl useradd chown docker apt-get apt dnf pacman pm2; do
    cat > "$TMP/bin/$cmd" <<EOF
#!/usr/bin/env bash
echo "\$(basename "\$0") \$*" >> "$TMP/stub.log"
exit 0
EOF
    chmod +x "$TMP/bin/$cmd"
done
export PATH="$TMP/bin:$PATH"

export AIRLINK_OS_RELEASE="$TMP/os-release"
export AIRLINK_PANEL_DIR="$TMP/panel"
export AIRLINK_DAEMON_DIR="$TMP/daemon"
export AIRLINK_UNIT_DIR="$TMP/units"

# run <expected-rc> <desc> -- <cmd...>
run() {
    local want="$1" desc="$2"; shift 3
    local rc=0
    set +e
    "$@" > "$TMP/out.log" 2>&1
    rc=$?
    set -e
    if [ "$rc" -ne "$want" ]; then
        sed 's/^/    | /' "$TMP/out.log" >&2
        fail "$desc: expected rc $want, got $rc"
    fi
    pass "$desc (rc $rc)"
}

assert_no_changes() {
    [ ! -s "$TMP/stub.log" ] || { cat "$TMP/stub.log"; fail "system commands were invoked"; }
    [ -z "$(ls -A "$TMP/panel")" ] || fail "panel dir changed"
    [ -z "$(ls -A "$TMP/daemon")" ] || fail "daemon dir changed"
    [ -z "$(ls -A "$TMP/units")" ] || fail "unit dir changed"
    pass "zero system changes"
}

# --- flag matrix (real entry, no TTY/root needed) ----------------------------
run 0 "help" -- bun installer.ts --help
grep -qi "usage" "$TMP/out.log" || fail "--help output lacks usage"
pass "help prints usage"

run 2 "plain with no action" -- bun installer.ts --no-color
run 2 "unknown flag" -- bun installer.ts --no-color --wat
run 2 "uninstall without --yes" -- bun installer.ts --no-color --uninstall-panel

# --- demo: exit 0, checkmarks, no changes ------------------------------------
run 0 "demo install panel" -- bun installer.ts --no-color --demo --install-panel
grep -q "✓" "$TMP/out.log" || { cat "$TMP/out.log"; fail "demo output lacks ✓ lines"; }
pass "demo prints checkmarks"
assert_no_changes

# --- non-interactive fallback (no --no-color anywhere) ------------------------
# stdout is redirected by run(), so there is no TTY: must auto-fall-back, not die
run 0 "auto plain without --no-color" -- bun installer.ts --demo --install-panel
grep -q "no TTY" "$TMP/out.log" || fail "auto-fallback notice missing"
pass "auto-fallback notice printed"
assert_no_changes

# action + --yes is the scripted contract: silent plain, no notice
run 0 "action+--yes runs scripted" -- bun installer.ts --demo --install-both --yes
if grep -q "no TTY" "$TMP/out.log"; then fail "scripted path should be silent"; fi
pass "action+--yes is silent"
assert_no_changes

# --- bootstrap smoke over file:// --------------------------------------------
case "$(uname -m)" in
    x86_64|amd64)  arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) fail "unsupported e2e arch: $(uname -m)" ;;
esac
ASSET="airlink-installer-linux-${arch}"

cat > "$TMP/fixtures/$ASSET" <<'EOF'
#!/usr/bin/env bash
# stand-in for the compiled installer: echoes argv, exits with $STUB_RC
echo "stub args: $*"
exit "${STUB_RC:-0}"
EOF
chmod +x "$TMP/fixtures/$ASSET"
(cd "$TMP/fixtures" && sha256sum "$ASSET" > "$ASSET.sha256")

export AIRLINK_INSTALLER_DL="file://$TMP/fixtures"

run 0 "bootstrap: download + run stub" -- bash "$BOOTSTRAP" --no-color --demo --install-panel
grep -q "stub args: --no-color --demo --install-panel" "$TMP/out.log" \
    || { cat "$TMP/out.log"; fail "bootstrap did not forward flags verbatim"; }
grep -q "checksum ok" "$TMP/out.log" || fail "bootstrap skipped sidecar verification"
pass "bootstrap forwards flags verbatim + verifies checksum"

# no TTY + no --no-color: bootstrap must warn and let the binary fall back, not die
run 0 "bootstrap: auto plain fallback" -- bash "$BOOTSTRAP" --demo --install-panel
grep -q "stub args: --demo --install-panel" "$TMP/out.log" \
    || { cat "$TMP/out.log"; fail "bootstrap auto-fallback lost flag forwarding"; }
grep -q "falling back to plain logs" "$TMP/out.log" || fail "bootstrap missing fallback warning"
pass "bootstrap falls back without --no-color"

export STUB_RC=42
run 42 "bootstrap: propagates stub rc" -- bash "$BOOTSTRAP" --no-color --help
unset STUB_RC
pass "bootstrap propagates rc"

# checksum mismatch must die (rc 1), never run the binary
printf 'deadbeef  %s\n' "$ASSET" > "$TMP/fixtures/$ASSET.sha256"
run 1 "bootstrap: checksum mismatch dies" -- bash "$BOOTSTRAP" --no-color --help
grep -qi "mismatch" "$TMP/out.log" || fail "mismatch death lacks message"
pass "bootstrap reports checksum mismatch"

# .gz fallback: when a packer target refuses, CI ships only `${ASSET}.gz` -
# the bootstrap must fetch it, verify the sidecar over the compressed bytes,
# decompress, and run the binary
rm -f "$TMP/fixtures/$ASSET" "$TMP/fixtures/$ASSET.sha256"
cat > "$TMP/stub.sh" <<'EOF'
#!/usr/bin/env bash
# stand-in for the compiled installer: echoes argv, exits with $STUB_RC
echo "stub args: $*"
exit "${STUB_RC:-0}"
EOF
gzip -9 -n -c "$TMP/stub.sh" > "$TMP/fixtures/$ASSET.gz"
(cd "$TMP/fixtures" && sha256sum "$ASSET.gz" > "$ASSET.gz.sha256")
run 0 "bootstrap: .gz fallback asset" -- bash "$BOOTSTRAP" --no-color --help
grep -q "trying ${ASSET}.gz" "$TMP/out.log" || { cat "$TMP/out.log"; fail "gz fallback never attempted"; }
grep -q "checksum ok" "$TMP/out.log" || fail "gz sidecar not verified"
grep -q "stub args: --no-color --help" "$TMP/out.log" || fail "gz fallback did not run the decompressed stub"
pass "bootstrap falls back to the .gz asset"

echo "e2e: all scenarios passed"
