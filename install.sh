#!/bin/bash
# Installs the Figma PowerPoint Export plugin into the Figma desktop app on macOS as a
# "plugin in development". No menus, no dialogs: it writes the same registry entry that
# Plugins → Development → Import plugin from manifest… would write.
#
#   Install or update:
#     curl -fsSL https://raw.githubusercontent.com/benjipunk/Figma-Powerpoint-Export/main/install.sh | bash
#   Remove:
#     curl -fsSL https://raw.githubusercontent.com/benjipunk/Figma-Powerpoint-Export/main/install.sh | bash -s -- --uninstall
#
# Set FPE_BASE_URL to fetch manifest.json, code.js and ui.html from somewhere else (file:// works).
set -euo pipefail

BASE_URL="${FPE_BASE_URL:-https://raw.githubusercontent.com/benjipunk/Figma-Powerpoint-Export/main/release}"
DEST="$HOME/Library/Application Support/FigmaPowerpointExport"
SETTINGS="$HOME/Library/Application Support/Figma/settings.json"
MODE="${1:-install}"

say() { printf '%s\n' "$*"; }
die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[ "$(uname)" = Darwin ] || die "This installer only works on macOS."
if [ ! -f "$SETTINGS" ]; then
  [ -d /Applications/Figma.app ] || [ -d "$HOME/Applications/Figma.app" ] || die "Figma desktop isn't installed. Download it from figma.com/downloads, open it once, then run this again."
  say "Figma hasn't been opened on this Mac yet. Opening it once so it creates its settings…"
  open -a Figma
  i=0; while [ ! -f "$SETTINGS" ] && [ $i -lt 60 ]; do sleep 1; i=$((i + 1)); done
  [ -f "$SETTINGS" ] || die "Figma didn't create its settings file. Sign in to Figma, quit it, then run this again."
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- Registry editing is done with JavaScript for Automation, which every Mac has. ---------
cat > "$TMP/registry.js" <<'JS'
ObjC.import('Foundation')
function readFile(p) {
  const s = $.NSString.stringWithContentsOfFileEncodingError(p, $.NSUTF8StringEncoding, null)
  if (s.isNil()) throw new Error('cannot read ' + p)
  return ObjC.unwrap(s)
}
function writeFile(p, text) {
  const ok = $.NSString.alloc.initWithUTF8String(text).writeToFileAtomicallyEncodingError(p, true, $.NSUTF8StringEncoding, null)
  if (!ok) throw new Error('cannot write ' + p)
}
function run(argv) {
  const [mode, settingsPath, dest, manifestFile] = argv
  const data = JSON.parse(readFile(settingsPath))
  const ext = Array.isArray(data.localFileExtensions) ? data.localFileExtensions : []
  const manifestPath = dest + '/manifest.json'
  const mine = ext.filter((e) => e.manifestPath === manifestPath && e.fileMetadata && e.fileMetadata.type === 'manifest')
  if (mode === 'check') return mine.length ? 'registered' : 'missing'
  if (mode === 'unregister') {
    const ids = new Set(mine.map((e) => e.id))
    data.localFileExtensions = ext.filter((e) => !ids.has(e.id) && !(e.fileMetadata && ids.has(e.fileMetadata.manifestFileId)))
    writeFile(settingsPath, JSON.stringify(data))
    return mine.length ? 'removed' : 'absent'
  }
  if (mine.length) return 'registered'
  const manifest = JSON.parse(readFile(manifestFile))
  const other = ext.find((e) => e.lastKnownPluginId === manifest.id)
  const maxId = ext.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0)
  const mid = maxId + 1, cid = maxId + 2, uid = maxId + 3
  ext.push(
    { id: mid, manifestPath, lastKnownName: manifest.name, lastKnownPluginId: manifest.id, fileMetadata: { type: 'manifest', codeFileId: cid, uiFileIds: [uid] } },
    { id: cid, manifestPath: dest + '/dist/code.js', fileMetadata: { type: 'code', manifestFileId: mid } },
    { id: uid, manifestPath: dest + '/dist/ui.html', fileMetadata: { type: 'ui', manifestFileId: mid } }
  )
  data.localFileExtensions = ext
  writeFile(settingsPath, JSON.stringify(data))
  return other ? 'added (note: also registered from ' + other.manifestPath + ')' : 'added'
}
JS
registry() { osascript -l JavaScript "$TMP/registry.js" "$@"; }

figma_running() { pgrep -xq Figma; }
quit_figma() {
  figma_running || return 0
  say "Quitting Figma so its plugin list can be updated…"
  osascript -e 'tell application "Figma" to quit' >/dev/null 2>&1 || true
  local i=0
  while figma_running && [ $i -lt 30 ]; do sleep 1; i=$((i + 1)); done
  if figma_running; then
    pkill -x Figma || true
    i=0; while figma_running && [ $i -lt 10 ]; do sleep 1; i=$((i + 1)); done
  fi
  figma_running && die "Figma is still running. Quit it and run this again."
  sleep 1
}

if [ "$MODE" = "--uninstall" ]; then
  quit_figma
  cp "$SETTINGS" "$SETTINGS.bak-fpe"
  result="$(registry unregister "$SETTINGS" "$DEST" "")"
  rm -rf "$DEST"
  say "Plugin files removed; registry entry $result. Opening Figma…"
  open -a Figma
  exit 0
fi
[ "$MODE" = install ] || die "Unknown option: $MODE (use --uninstall to remove)."

say "Downloading the plugin…"
for f in manifest.json code.js ui.html; do
  curl -fsSL "$BASE_URL/$f" -o "$TMP/$f" || die "Could not download $f from $BASE_URL"
  [ -s "$TMP/$f" ] || die "Downloaded $f is empty."
done
grep -q '"main"' "$TMP/manifest.json" || die "manifest.json doesn't look like a Figma plugin manifest."

install_files() {
  mkdir -p "$DEST/dist"
  cp "$TMP/manifest.json" "$DEST/manifest.json"
  cp "$TMP/code.js" "$DEST/dist/code.js"
  cp "$TMP/ui.html" "$DEST/dist/ui.html"
}

if [ "$(registry check "$SETTINGS" "$DEST" "")" = registered ]; then
  install_files
  say "Updated. Figma loads the new version the next time you run the plugin."
  exit 0
fi

quit_figma
install_files
cp "$SETTINGS" "$SETTINGS.bak-fpe"
result="$(registry register "$SETTINGS" "$DEST" "$DEST/manifest.json")"
say "Registered with Figma ($result). Opening Figma…"
open -a Figma
say ""
say "Done. Open any Figma Slides deck, then: Plugins → Development → Figma Powerpoint Export"
