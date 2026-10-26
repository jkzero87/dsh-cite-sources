#!/usr/bin/env bash
# Install dsh-cite-sources into the desktop profile the way dsh-free-search and dsh-recall are wired:
#   1. tgz in $DSH_HOME/.local-packages/
#   2. profiles/desktop/package.json: "dependencies" file: entry + "dsh.profile.bundles" entry (bundle patch = cordis.patch.yml)
#   3. profiles/desktop/compatibility.json: plugin@version -> accepted DSH releases (copied from dsh-free-search's entry)
#   4. pnpm install --offline in profiles/desktop (updates pnpm-lock.yaml and node_modules), with the pnpm that
#      wrote the profile: node_modules/.modules.yaml records "packageManager": "pnpm@11.28.5", the version the app
#      bundles (resources/runtime/versions.json, $DSH_HOME/dsh-runtimes/dsh-primary-runtime/runtime.json); PATH pnpm
#      is used only when it reports that same version
#   5. packages patched in place after their install (NEXT.md: dsh-recall lib/index.js from ce2df4a, dsh-compaction-select)
#      are restored from the profile tarball if pnpm rewrote them
# Refuses to run while the app (or anything else) has DSH_HOME open. Backs up every file it changes, plus a
# tarball of the whole profile directory; on any failure after the backup it restores the profile directory from that tarball.
set -euo pipefail

DSH_HOME="${DSH_HOME:-$HOME/.local/share/deepseek-harness}"
PROFILE="$DSH_HOME/profiles/desktop"
LOCAL_PACKAGES="$DSH_HOME/.local-packages"
PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME=dsh-cite-sources
VERSION="$(node -p "require('$PKG_DIR/package.json').version")"
TGZ="$LOCAL_PACKAGES/$NAME-$VERSION.tgz"
TS="$(date +%Y%m%d-%H%M)"
TAG="bak-pre-cite-sources-$TS"

die() { echo "install_desktop: $*" >&2; exit 1; }

# 1. The app must be fully closed: no DeepSeek Harness process, nothing holding files under DSH_HOME.
APP_PATTERN='Applications/DeepSeek-Harness/|deepseek-harness/dsh-runtimes/'
if pgrep -f "$APP_PATTERN" >/dev/null; then
  pgrep -af "$APP_PATTERN" | cut -c1-160 >&2
  die "DeepSeek Harness is running; quit it completely (including the tray) and retry"
fi
if command -v lsof >/dev/null && lsof +D "$DSH_HOME" 2>/dev/null | tail -n +2 | grep -q .; then
  lsof +D "$DSH_HOME" 2>/dev/null >&2 || true
  die "files under $DSH_HOME are open (listed above); close those processes and retry"
fi

[ -f "$PROFILE/package.json" ] || die "no profile at $PROFILE"

# The pnpm that wrote this profile.
WANT_PNPM="$(grep -o '"packageManager": "pnpm@[^"]*"' "$PROFILE/node_modules/.modules.yaml" | head -1 | sed 's/.*pnpm@//; s/"$//')"
[ -n "$WANT_PNPM" ] || die "cannot read packageManager from $PROFILE/node_modules/.modules.yaml"
APP_DIR="${DSH_APP_DIR:-$HOME/Applications/DeepSeek-Harness}"
PNPM=()
for runtime in "$DSH_HOME/dsh-runtimes/dsh-primary-runtime/dependencies" "$APP_DIR/resources/runtime/primary-runtime/dependencies"; do
  if [ -x "$runtime/node/bin/node" ] && [ -f "$runtime/pnpm/bin/pnpm.mjs" ] \
    && [ "$(cd /tmp && "$runtime/node/bin/node" "$runtime/pnpm/bin/pnpm.mjs" --version 2>/dev/null)" = "$WANT_PNPM" ]; then
    PNPM=("$runtime/node/bin/node" "$runtime/pnpm/bin/pnpm.mjs")
    break
  fi
done
if [ ${#PNPM[@]} -eq 0 ] && command -v pnpm >/dev/null && [ "$(cd /tmp && pnpm --version)" = "$WANT_PNPM" ]; then
  PNPM=(pnpm)
fi
[ ${#PNPM[@]} -gt 0 ] || die "no pnpm $WANT_PNPM found (app runtime under $DSH_HOME/dsh-runtimes or $APP_DIR, or PATH)"
echo "using pnpm $WANT_PNPM: ${PNPM[*]}"
grep -q "\"$NAME\"" "$PROFILE/package.json" && die "$NAME is already in $PROFILE/package.json"

# 2. Gate on the package's own tests (real session logs, no network).
(cd "$PKG_DIR" && npm test >/dev/null) || die "npm test failed in $PKG_DIR"

# 3. Pack. Refuse to overwrite a different tgz of the same version.
PACK_DIR="$(mktemp -d)"
BACKED_UP=0
DONE=0
on_exit() {
  local status=$?
  rm -rf "$PACK_DIR"
  if [ "$BACKED_UP" = 1 ] && [ "$DONE" = 0 ]; then
    echo "install_desktop: failed; restoring $PROFILE from desktop.$TAG.tgz" >&2
    rm -rf "$PROFILE"
    tar -C "$DSH_HOME/profiles" -xzf "$DSH_HOME/profiles/desktop.$TAG.tgz"
    if [ -n "${NEW_TGZ:-}" ]; then rm -f "$TGZ"; fi
  fi
  exit "$status"
}
trap on_exit EXIT
(cd "$PKG_DIR" && npm pack --silent --pack-destination "$PACK_DIR" >/dev/null)
if [ -e "$TGZ" ] && ! cmp -s "$TGZ" "$PACK_DIR/$NAME-$VERSION.tgz"; then
  die "$TGZ exists with different content; bump the version"
fi

# 4. Back up every file this script changes, and the whole profile directory.
for f in package.json pnpm-lock.yaml compatibility.json; do
  [ -e "$PROFILE/$f" ] && cp -p "$PROFILE/$f" "$PROFILE/$f.$TAG"
done
tar -C "$DSH_HOME/profiles" -czf "$DSH_HOME/profiles/desktop.$TAG.tgz" desktop
echo "backups: $PROFILE/{package.json,pnpm-lock.yaml,compatibility.json}.$TAG and $DSH_HOME/profiles/desktop.$TAG.tgz"

BACKED_UP=1

if [ ! -e "$TGZ" ]; then
  cp "$PACK_DIR/$NAME-$VERSION.tgz" "$TGZ"
  NEW_TGZ=1
fi

# 5. package.json and compatibility.json (JSON edits; key order otherwise preserved).
node - "$PROFILE" "$NAME" "$VERSION" "$TGZ" <<'EOF'
const fs = require("node:fs");
const [profile, name, version, tgz] = process.argv.slice(2);
const pkgPath = `${profile}/package.json`;
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies[name] = `file:${tgz}`;
const bundles = pkg.dsh.profile.bundles;
if (!bundles.includes(name)) bundles.push(name);
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
const compatPath = `${profile}/compatibility.json`;
const compat = JSON.parse(fs.readFileSync(compatPath, "utf8"));
const reference = Object.entries(compat).find(([k]) => k.startsWith("dsh-free-search@"));
if (!reference) throw new Error("no dsh-free-search entry in compatibility.json to copy DSH releases from");
compat[`${name}@${version}`] = reference[1];
fs.writeFileSync(compatPath, `${JSON.stringify(compat, null, 2)}\n`);
EOF

# 6. Install from the local tgz only. Packages that are real directories (not links) are fingerprinted first,
#    because some were patched in place after install and a reinstall would revert them.
fingerprint() { (cd "$PROFILE/node_modules" && find "$1" -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64); }
declare -A BEFORE
for dir in "$PROFILE"/node_modules/dsh-*; do
  [ -d "$dir" ] && [ ! -L "$dir" ] || continue
  pkg="$(basename "$dir")"
  BEFORE[$pkg]="$(fingerprint "$pkg")"
done
(cd "$PROFILE" && "${PNPM[@]}" install --offline)
for pkg in "${!BEFORE[@]}"; do
  if [ ! -d "$PROFILE/node_modules/$pkg" ] || [ "$(fingerprint "$pkg")" != "${BEFORE[$pkg]}" ]; then
    echo "pnpm rewrote node_modules/$pkg; restoring the pre-install copy from desktop.$TAG.tgz"
    rm -rf "$PROFILE/node_modules/$pkg"
    tar -C "$DSH_HOME/profiles" -xzf "$DSH_HOME/profiles/desktop.$TAG.tgz" "desktop/node_modules/$pkg"
    [ "$(fingerprint "$pkg")" = "${BEFORE[$pkg]}" ] || die "could not restore node_modules/$pkg"
  fi
done

[ -f "$PROFILE/node_modules/$NAME/lib/index.js" ] || die "pnpm did not install $NAME"
[ -f "$PROFILE/node_modules/$NAME/cordis.patch.yml" ] || die "installed package lacks cordis.patch.yml"
DONE=1
echo "installed $NAME@$VERSION into $PROFILE; start the app and check that a web_search result shows [S1]."
