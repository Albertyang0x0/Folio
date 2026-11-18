#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")"
if [[ $(uname -s) != Darwin ]]; then
  echo '请在 macOS 上运行此脚本。' >&2
  exit 1
fi

python_bin=${PYTHON:-python3}
venv_dir=${FOLIO_BUILD_VENV:-.venv}
if [[ ! -x "$venv_dir/bin/python" ]]; then
  "$python_bin" -m venv "$venv_dir"
fi
python="$venv_dir/bin/python"
"$python" -m pip install -r packaging/requirements-build.txt
arch=$("$python" -c 'import platform; print(platform.machine())')

export FOLIO_VERSION=${FOLIO_VERSION:-0.2.1}
export FOLIO_BUILD_NUMBER=${FOLIO_BUILD_NUMBER:-201}
feed=${FOLIO_UPDATE_FEED_URL:-}
public_key=${FOLIO_UPDATE_PUBLIC_KEY:-}
identity=${FOLIO_SIGN_IDENTITY:-}
notary_profile=${FOLIO_NOTARY_PROFILE:-}
dist_dir=${FOLIO_DIST_DIR:-dist}
if [[ -n $notary_profile && -z $identity ]]; then
  echo 'Apple 公证需要设置 FOLIO_SIGN_IDENTITY。' >&2
  exit 1
fi
"$python" - "$FOLIO_VERSION" "$FOLIO_BUILD_NUMBER" "$feed" "$public_key" <<'PY'
import base64
import binascii
import re
import sys
from urllib.parse import urlsplit

version, build, feed, key = sys.argv[1:]
if not re.fullmatch(r"\d+\.\d+\.\d+", version) or not re.fullmatch(r"[1-9]\d*", build):
    sys.exit("请使用 x.y.z 版本号和递增的整数构建号。")
if feed or key:
    url = urlsplit(feed)
    if (not url.hostname or url.username or url.password or url.fragment
            or not (url.scheme == "https" or (url.scheme == "http" and url.hostname == "127.0.0.1"))):
        sys.exit("更新源须使用 HTTPS。本机更新测试可以使用 http://127.0.0.1。")
    try:
        assert len(base64.b64decode(key, validate=True)) == 32
    except (binascii.Error, AssertionError):
        sys.exit("更新需要一个有效的 Sparkle EdDSA 公钥。")
PY

mkdir -p build "$dist_dir"
stage=$(mktemp -d "$PWD/build/macos-package.XXXXXX")
trap 'rm -rf "$stage"' EXIT
"$python" - "$stage/Folio.icns" <<'PY'
import sys

from PIL import Image

with Image.open("frontend/assets/yueyu-glacier.png") as image:
    image.convert("RGBA").save(sys.argv[1], format="ICNS")
PY

FOLIO_MACOS_ICON="$stage/Folio.icns" "$python" -m PyInstaller --clean --noconfirm \
  --distpath "$stage/output" --workpath "$stage/work" FolioMac.spec
app="$stage/output/Folio.app"
if [[ -n $feed ]]; then
  sparkle_dir=$(./scripts/fetch_sparkle.sh)
  framework="$app/Contents/Frameworks/Sparkle.framework"
  /usr/bin/ditto "$sparkle_dir/Sparkle.framework" "$framework"
  cp "$sparkle_dir/LICENSE" "$app/Contents/Resources/Sparkle-LICENSE"
  sign=(/usr/bin/codesign --force --sign "${identity:--}")
  if [[ -n $identity ]]; then
    sign+=(--options runtime --timestamp)
  fi
  sparkle_version="$framework/Versions/B"
  for item in "$sparkle_version"/XPCServices/*.xpc "$sparkle_version/Autoupdate" "$sparkle_version/Updater.app" "$sparkle_version"; do
    "${sign[@]}" "$item"
  done
fi
if [[ -n $identity ]]; then
  /usr/bin/codesign --force --options runtime --timestamp --sign "$identity" "$app"
elif [[ -n $feed ]]; then
  /usr/bin/codesign --force --sign - "$app"
fi
/usr/bin/codesign --verify --deep --strict "$app"
archive="$stage/Folio-macOS-$arch.zip"
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
if [[ -n $notary_profile ]]; then
  xcrun notarytool submit "$archive" --keychain-profile "$notary_profile" --wait --output-format json > "$stage/notary.json"
  "$python" - "$stage/notary.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as file:
    response = json.load(file)
print(f"Apple 公证 {response.get('id')}: {response.get('status')}")
if response.get("status") != "Accepted":
    sys.exit(1)
PY
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  rm "$archive"
  /usr/bin/ditto -c -k --sequesterRsrc --keepParent "$app" "$archive"
fi

mkdir "$stage/disk-image"
/usr/bin/ditto "$app" "$stage/disk-image/Folio.app"
ln -s /Applications "$stage/disk-image/Applications"
disk_image="$stage/Folio-$FOLIO_VERSION-macOS-$arch.dmg"
hdiutil create -quiet -volname "Folio $FOLIO_VERSION" -srcfolder "$stage/disk-image" \
  -format UDZO "$disk_image"
if [[ -n $identity ]]; then
  /usr/bin/codesign --sign "$identity" --timestamp "$disk_image"
fi
if [[ -n $notary_profile ]]; then
  xcrun notarytool submit "$disk_image" --keychain-profile "$notary_profile" --wait --output-format json > "$stage/dmg-notary.json"
  "$python" - "$stage/dmg-notary.json" <<'PY'
import json
import sys

with open(sys.argv[1]) as file:
    response = json.load(file)
print(f"Apple DMG 公证 {response.get('id')}: {response.get('status')}")
if response.get("status") != "Accepted":
    sys.exit(1)
PY
  xcrun stapler staple "$disk_image"
  xcrun stapler validate "$disk_image"
fi

if [[ -e "$dist_dir/Folio.app" || -L "$dist_dir/Folio.app" ]]; then
  mv "$dist_dir/Folio.app" "$stage/previous.app"
fi
if ! mv "$app" "$dist_dir/Folio.app"; then
  if [[ -e "$stage/previous.app" || -L "$stage/previous.app" ]]; then
    mv "$stage/previous.app" "$dist_dir/Folio.app"
  fi
  exit 1
fi
mv "$archive" "$dist_dir/"
mv "$disk_image" "$dist_dir/"
printf '构建完成：%s/Folio.app、ZIP 和 DMG。\n' "$dist_dir"
