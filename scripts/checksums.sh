#!/bin/sh
# scripts/checksums.sh [dir] [outfile]
#
# Writes the sha256 of every chaff-* artifact in `dir` to `outfile`, in the
# `<hash>  <name>` form `sha256sum -c` reads and `install.sh` parses. The
# release job runs this once, after the build jobs' artifacts are collected, so
# the published checksums describe exactly the bytes that were uploaded.
#
# It hashes whatever is there and has nothing to say about a missing artifact:
# `ls` on an empty directory is a release that uploads nothing, and the release
# job fails before this point if a build is missing.
#
# macOS has no `sha256sum`, so the tool is picked at run time (same three-step
# probe as the installer, which has to verify what this file promises).
set -eu

dir=${1:-dist}
out=${2:-}

if [ ! -d "$dir" ]; then
  echo "checksums: no such directory: $dir" >&2
  exit 1
fi

if [ -z "$out" ]; then
  out="$dir/checksums.txt"
fi

# One file's sha256, whichever tool this machine has.
hash_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "$1" | awk '{ print $NF }'
  else
    echo "checksums: no sha256 tool found (sha256sum, shasum, or openssl)" >&2
    exit 1
  fi
}

: >"$out"
count=0

# The glob is sorted by the shell, so the file is stable across runs.
for file in "$dir"/chaff-*; do
  [ -f "$file" ] || continue
  name=$(basename "$file")
  printf '%s  %s\n' "$(hash_of "$file")" "$name" >>"$out"
  count=$((count + 1))
done

if [ "$count" -eq 0 ]; then
  echo "checksums: no chaff-* artifacts in $dir" >&2
  exit 1
fi

echo "checksums: $count artifact(s) written to $out"
cat "$out"
