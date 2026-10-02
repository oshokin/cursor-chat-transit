#!/bin/sh
# Locate or install the Node.js toolchain pinned in `.nvmrc`.
# Task does not source ~/.bashrc, so nvm functions are invisible. Cursor's
# helper node has no npm. A different Node 24 already on PATH is not reused.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
TOOLS=$ROOT/.tools/node
DIST=https://nodejs.org/dist
UA=cursor-chat-transit-dev-node
BIN_DIR=

# Write to stderr and exit.
fail() {
  printf '%s\n' "$*" >&2
  exit 1
}

# Read the first non-comment token from .nvmrc.
wanted_version() {
  ver=
  while IFS= read -r line || [ -n "$line" ]; do
    line=${line%%#*}
    set -- $line
    [ $# -eq 0 ] && continue
    ver=${1#v}
    break
  done <"$ROOT/.nvmrc"
  [ -n "$ver" ] || fail '.nvmrc does not contain a Node version.'
  VERSION=$ver
  MAJOR=${ver%%.*}
  case $MAJOR in
    *[!0-9]*) fail "Unsupported Node version in .nvmrc: $ver" ;;
  esac
}

# Accept a directory whose Node version is exactly the .nvmrc pin, with npm beside it.
consider() {
  dir=$1
  [ -n "$dir" ] && [ -x "$dir/node" ] && [ -f "$dir/npm" ] || return 1
  node_ver=$("$dir/node" -p 'process.versions.node' 2>/dev/null) || return 1
  [ "$node_ver" = "$VERSION" ] || return 1
  BIN_DIR=$dir
  return 0
}

# Search .tools, PATH, nvm, fnm, mise, volta, and asdf for a matching toolchain.
# CCT_DEV_NODE_ISOLATE=1 (tests) considers only this repo's .tools/node.
find_bin() {
  BIN_DIR=
  consider "$TOOLS/bin" && return 0
  consider "$TOOLS" && return 0
  if [ -n "${CCT_DEV_NODE_ISOLATE:-}" ]; then
    return 1
  fi
  old_ifs=$IFS
  IFS=:
  for dir in $PATH; do
    IFS=$old_ifs
    consider "$dir" && return 0
  done
  IFS=$old_ifs
  nvm_root=${NVM_DIR:-$HOME/.nvm}
  consider "$nvm_root/versions/node/v$VERSION/bin" && return 0
  consider "$HOME/.fnm/node-versions/v$VERSION/installation/bin" && return 0
  consider "$HOME/.local/share/fnm/node-versions/v$VERSION/installation/bin" && return 0
  consider "$HOME/.local/share/mise/installs/node/$VERSION/bin" && return 0
  consider "$HOME/.local/share/mise/installs/node/v$VERSION/bin" && return 0
  consider "$HOME/.volta/bin" && return 0
  consider "$HOME/.asdf/installs/nodejs/$VERSION/bin" && return 0
  return 1
}

# Official nodejs.org archive name for this OS and CPU.
archive_name() {
  sys=$(uname -s)
  mach=$(uname -m)
  case $mach in
    x86_64 | amd64) arch=x64 ;;
    arm64 | aarch64) arch=arm64 ;;
    *) fail "No official Node.js build is mapped for machine $mach." ;;
  esac
  case $sys in
    Linux) ARCHIVE=node-v$VERSION-linux-$arch.tar.xz ;;
    Darwin) ARCHIVE=node-v$VERSION-darwin-$arch.tar.gz ;;
    *)
      fail "task setup downloads official Node.js on Linux and macOS. On $sys install Node $VERSION from https://nodejs.org/en/download and retry."
      ;;
  esac
}

# Download a URL with curl, or wget if curl is missing.
fetch() {
  url=$1
  dest=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -A "$UA" -o "$dest" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" --header="User-Agent: $UA" "$url"
  else
    fail 'curl or wget is required to download Node.js.'
  fi
}

# SHA-256 of a file as lowercase hex.
file_sha() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    fail 'sha256sum or shasum is required to verify the Node.js archive.'
  fi
}

# Checksum for ARCHIVE from the official SHASUMS256.txt.
expected_sha() {
  sums=$(mktemp)
  fetch "$DIST/v$VERSION/SHASUMS256.txt" "$sums"
  got=$(awk -v name="$ARCHIVE" '$2 == name || $2 == "*" name { print $1; exit }' "$sums")
  rm -f "$sums"
  [ -n "$got" ] || fail "No SHA-256 listed for $ARCHIVE in the Node.js SHASUMS256.txt."
  printf '%s\n' "$got"
}

# Download, verify, and unpack the official Node.js build into .tools/node.
install_official() {
  archive_name
  printf 'Downloading Node.js %s (%s) from nodejs.org…\n' "$VERSION" "$ARCHIVE"
  mkdir -p "$ROOT/.tools"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  fetch "$DIST/v$VERSION/$ARCHIVE" "$tmp/$ARCHIVE"
  actual=$(file_sha "$tmp/$ARCHIVE")
  expected=$(expected_sha)
  if [ "$actual" != "$expected" ]; then
    fail "Node.js archive checksum mismatch.
  expected $expected
  actual   $actual"
  fi
  mkdir -p "$tmp/unpacked"
  case $ARCHIVE in
    *.tar.xz) tar -xJf "$tmp/$ARCHIVE" -C "$tmp/unpacked" ;;
    *.tar.gz) tar -xzf "$tmp/$ARCHIVE" -C "$tmp/unpacked" ;;
    *) fail "Unexpected archive type: $ARCHIVE" ;;
  esac
  root=
  for dir in "$tmp/unpacked"/*; do
    if [ -x "$dir/bin/node" ]; then
      root=$dir
      break
    fi
  done
  [ -n "$root" ] || fail 'Unexpected layout in the downloaded Node.js archive.'
  rm -rf "$TOOLS"
  mv "$root" "$TOOLS"
  trap - EXIT
  rm -rf "$tmp"
  consider "$TOOLS/bin" || fail 'Downloaded Node.js, but npm was not found next to node.'
  printf 'Installed %s at %s\n' "$("$BIN_DIR/node" -p 'process.versions.node')" "$BIN_DIR"
}

# Explain how to obtain Node when none was found.
missing_message() {
  printf '%s\n' \
    "Node.js $VERSION and npm are not on PATH." \
    "Cursor helper \`node\` is not a toolchain: it has no npm." \
    'Interactive nvm in ~/.bashrc is also invisible to Task.' \
    '' \
    'From this repository run:' \
    '  task setup' \
    '' \
    'That downloads the official Node.js build pinned in .nvmrc into' \
    '.tools/node (gitignored) and then runs npm ci.' \
    '' \
    'If you prefer a version manager in your shell, install one, then retry:' \
    '  fnm  https://github.com/Schniz/fnm  (reads .nvmrc, works in Task)' \
    '  nvm  https://github.com/nvm-sh/nvm  (source nvm.sh, then nvm install)' \
    'Official builds: https://nodejs.org/en/download' \
    'Do not use distro `apt install npm` as the project toolchain.'
}

# Put BIN_DIR first on PATH for the following command.
with_node_env() {
  PATH=$BIN_DIR:$PATH
  export PATH
  unset npm_config_devdir NPM_CONFIG_DEVDIR
}

# Print the resolved node, npm, and which tree they came from.
print_status() {
  origin=$BIN_DIR
  case $BIN_DIR in
    "$TOOLS" | "$TOOLS"/bin) origin='project .tools/node' ;;
  esac
  printf 'node %s  %s\n' "$("$BIN_DIR/node" -p 'process.versions.node')" "$BIN_DIR/node"
  printf 'npm  %s\n' "$BIN_DIR/npm"
  printf 'bin   %s (%s)\n' "$BIN_DIR" "$origin"
}

SETUP=0
STATUS=0
while [ $# -gt 0 ]; do
  case $1 in
    --setup)
      SETUP=1
      shift
      ;;
    --status)
      STATUS=1
      shift
      ;;
    --)
      shift
      break
      ;;
    *)
      break
      ;;
  esac
done

wanted_version
FOUND=0
if find_bin; then
  FOUND=1
fi

if [ "$SETUP" -eq 1 ]; then
  if [ "$FOUND" -eq 0 ]; then
    install_official
  else
    printf 'Using Node %s at %s\n' "$("$BIN_DIR/node" -p 'process.versions.node')" "$BIN_DIR"
  fi
  with_node_env
  npm ci
  exit $?
fi

if [ "$FOUND" -eq 0 ]; then
  missing_message
  exit 1
fi

if [ "$STATUS" -eq 1 ] || [ $# -eq 0 ]; then
  print_status
  exit 0
fi

with_node_env
exec "$@"
