#!/bin/bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
version=2.10.1
sha=1a856d2a9edb8e628de88121d7be04cf0e2167f8641650b78fca00b14244cf27
cache="$root/build/sparkle-$version"
if [[ ! -d "$cache/Sparkle.framework" || ! -x "$cache/bin/generate_appcast" ]]; then
  mkdir -p "$root/build"
  tmp=$(mktemp -d "$root/build/sparkle-download.XXXXXX")
  trap 'rm -rf "$tmp"' EXIT
  archive="$tmp/Sparkle-$version.tar.xz"
  curl --fail --silent --show-error --location --connect-timeout 15 --max-time 180 --retry 2 \
    "https://github.com/sparkle-project/Sparkle/releases/download/$version/Sparkle-$version.tar.xz" -o "$archive"
  printf '%s  %s\n' "$sha" "$archive" | shasum -a 256 -c >&2
  tar -xJf "$archive" -C "$tmp"
  mkdir -p "$cache"
  /usr/bin/ditto "$tmp/Sparkle.framework" "$cache/Sparkle.framework"
  /usr/bin/ditto "$tmp/bin" "$cache/bin"
  cp "$tmp/LICENSE" "$cache/LICENSE"
fi
printf '%s\n' "$cache"
