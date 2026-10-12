#!/bin/sh
# chaff-tg installer: one command on a fresh machine, no runtime to install.
#
#   curl -fsSL https://raw.githubusercontent.com/Michael-Obele/chaff-tg/main/install.sh | sh
#
# What it does, and nothing else (plan/distribution.md, "Installer"):
#
#   1. Detects the OS and CPU, and musl on Linux by looking for
#      /lib/ld-musl-*.so.1, because a glibc binary will not start on Alpine.
#   2. Picks the matching artifact out of the eight the release holds.
#   3. Downloads the artifact and checksums.txt, and verifies sha256 BEFORE
#      anything executable is written anywhere.
#   4. Installs to ~/.local/bin/chaff, or /usr/local/bin with --system, and
#      prints the PATH line when the directory is not already on it.
#
# It never runs sudo on its own: with --system and no permission it stops and
# prints the command for you to run.
#
# The default is the LATEST release (`releases/latest/download`, so no API call
# and no rate limit); `--version v0.1.0` pins one. `--dry-run` prints the plan
# and stops before downloading. `--base-url` points the download at somewhere
# other than GitHub, which is how the installer is tested against a stub.
#
# POSIX sh only, and it reads no stdin: it is meant to be piped into `sh`.

set -eu

REPO="Michael-Obele/chaff-tg"
BINARY="chaff"

usage() {
  cat <<'EOF'
Install chaff-tg.

Usage: install.sh [options]

Options:
  --version <tag>    Install a specific release, e.g. --version v0.1.0.
                     Default: the latest release.
  --system           Install to /usr/local/bin instead of ~/.local/bin.
  --dir <path>       Install to <path> instead of the defaults above.
  --dry-run          Print what would happen, and stop before downloading.
  --base-url <url>   Download from <url> instead of GitHub releases.
                     Expects <url>/<artifact> and <url>/checksums.txt.
  -h, --help         Show this help.

Environment:
  CHAFF_INSTALL_DIR  Directory to install into (--dir wins over it).
EOF
}

die() {
  printf 'chaff: %s\n' "$1" >&2
  exit 1
}

version=""
use_system=0
dry_run=0
dir_override=""
base_url=""

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || die "--version needs a tag"
      version=$2
      shift 2
      ;;
    --system)
      use_system=1
      shift
      ;;
    --dir)
      [ $# -ge 2 ] || die "--dir needs a path"
      dir_override=$2
      shift 2
      ;;
    --dry-run)
      dry_run=1
      shift
      ;;
    --base-url)
      [ $# -ge 2 ] || die "--base-url needs a url"
      base_url=$2
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (try --help)"
      ;;
  esac
done

# --- detect the platform -----------------------------------------------------

uname_s=$(uname -s)
uname_m=$(uname -m)

case "$uname_s" in
  Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *)
    printf 'chaff: no build for "%s".\n' "$uname_s" >&2
    printf 'On Windows, download chaff-bun-windows-x64.exe (or -arm64.exe) from\n' >&2
    printf 'https://github.com/%s/releases and run it.\n' "$REPO" >&2
    exit 1
    ;;
esac

case "$uname_m" in
  x86_64 | amd64) cpu="x64" ;;
  arm64 | aarch64) cpu="arm64" ;;
  *) die "no build for CPU \"$uname_m\"" ;;
esac

libc=""
if [ "$os" = "linux" ]; then
  # Musl, decided by the host's own C library rather than by the loader's
  # presence. plan/distribution.md says to look for /lib/ld-musl-*.so.1, and
  # that alone is wrong on a glibc host that has musl-tools or a musl cross
  # toolchain installed: found on the dev machine on 2026-10-12, where
  # /lib/ld-musl-x86_64.so.1 exists under GLIBC 2.39, so the loader probe
  # picked the musl build for a glibc system. `ldd` answers the real question,
  # and the loader stays as the fallback for a system whose `ldd` says nothing.
  if ldd --version 2>&1 | grep -qi musl; then
    libc="-musl"
  elif ldd --version 2>&1 | grep -qi glibc; then
    libc=""
  else
    for candidate in /lib/ld-musl-*.so.1; do
      if [ -e "$candidate" ]; then
        libc="-musl"
        break
      fi
    done
  fi
fi

target="bun-${os}-${cpu}${libc}"
artifact="chaff-${target}"

# --- work out where it comes from -------------------------------------------

if [ -n "$version" ]; then
  case "$version" in
    v*) tag="$version" ;;
    *) tag="v$version" ;;
  esac
  where="release $tag"
else
  tag="latest"
  where="the latest release"
fi

if [ -n "$base_url" ]; then
  base=${base_url%/}
  artifact_url="$base/$artifact"
  checksums_url="$base/checksums.txt"
else
  # GitHub spells the two cases differently: a pinned tag is
  # `releases/download/<tag>/<file>`, but the latest release is
  # `releases/latest/download/<file>`. Building `releases/<tag>/download`
  # works for the literal tag "latest" and 404s for every real tag, which is
  # how `--version v0.1.0` shipped broken (found 2026-10-12, on the first
  # release, by running this against GitHub instead of a --base-url stub).
  if [ "$tag" = "latest" ]; then
    release="https://github.com/$REPO/releases/latest/download"
  else
    release="https://github.com/$REPO/releases/download/$tag"
  fi
  artifact_url="$release/$artifact"
  checksums_url="$release/checksums.txt"
fi

# --- work out where it goes --------------------------------------------------

if [ -n "$dir_override" ]; then
  install_dir=$dir_override
elif [ "$use_system" -eq 1 ]; then
  install_dir="/usr/local/bin"
elif [ -n "${CHAFF_INSTALL_DIR:-}" ]; then
  install_dir=$CHAFF_INSTALL_DIR
else
  install_dir="$HOME/.local/bin"
fi

printf 'chaff-tg: %s\n' "$where"
printf '  platform   %s (%s%s)\n' "$os" "$cpu" "$libc"
printf '  artifact   %s\n' "$artifact"
printf '  from       %s\n' "$artifact_url"
printf '  install to %s/%s\n' "$install_dir" "$BINARY"

if [ "$dry_run" -eq 1 ]; then
  printf '\ndry run: nothing was downloaded and nothing was written.\n'
  exit 0
fi

# --- download, verify, install ----------------------------------------------

download() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "neither curl nor wget is available"
  fi
}

# The three sha256 spellings across the platforms this installs on.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  else
    die "no sha256 tool found (sha256sum, shasum, or openssl), so the download cannot be verified"
  fi
}

work=$(mktemp -d) || die "cannot create a temporary directory"
# Nothing verified or written lives here; the install itself lands in place.
trap 'rm -rf "$work"' EXIT INT TERM HUP

printf '\ndownloading...\n'
download "$checksums_url" "$work/checksums.txt" ||
  die "cannot download $checksums_url (is $where published?)"

expected=$(awk -v name="$artifact" '$2 == name { print $1 }' "$work/checksums.txt")
[ -n "$expected" ] ||
  die "checksums.txt has no entry for $artifact, so this release cannot be verified"

download "$artifact_url" "$work/$artifact" || die "cannot download $artifact_url"

actual=$(sha256_of "$work/$artifact")
if [ "$actual" != "$expected" ]; then
  printf 'chaff: checksum mismatch for %s\n' "$artifact" >&2
  printf '  expected %s\n  got      %s\n' "$expected" "$actual" >&2
  printf 'Nothing was installed. Do not run this download.\n' >&2
  exit 1
fi
printf '  verified   sha256 %s\n' "$actual"

if ! mkdir -p "$install_dir" 2>/dev/null; then
  die "cannot create $install_dir. Run it by hand, for example:
  sudo mkdir -p $install_dir && sudo cp <downloaded $artifact> $install_dir/$BINARY"
fi

# Write beside the destination and move it into place, so a failure halfway
# through never leaves a half-written binary where a program is expected.
dest="$install_dir/$BINARY"
staged="$install_dir/.$BINARY.$$"
if ! cp "$work/$artifact" "$staged" 2>/dev/null; then
  die "cannot write to $install_dir. Nothing was installed. To do it by hand:
  sudo install -m 755 $work/$artifact $dest"
fi
chmod 755 "$staged"
mv -f "$staged" "$dest"

printf '\ninstalled %s\n' "$dest"

case ":${PATH}:" in
  *":$install_dir:"*) ;;
  *)
    printf '\n%s is not on your PATH. Add it:\n\n  export PATH="%s:$PATH"\n' \
      "$install_dir" "$install_dir"
    ;;
esac

printf '\nRun chaff --version to check it, then chaff list to look before you touch\n'
printf 'anything. The session file it writes is the whole account: keep it private.\n'
