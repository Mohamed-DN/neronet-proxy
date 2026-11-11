#!/bin/sh
# Usage: publish-downloads.sh <downloads-dir> <platform>=<file>[@<version>] ...
#
#   publish-downloads.sh ~/neronet/downloads \
#     linux=dist/linux/neronet_4.0.0_amd64.deb@4.0.0 \
#     android=app-debug.apk@1.0.0-debug
#
# Copies each file into <downloads-dir> and writes <downloads-dir>/manifest.json, the
# list the /me page shows (platform, version, file, size, SHA-256). Platforms: android,
# windows, macos, linux; one file each, a later argument for the same platform wins.
# Sizes and hashes are measured here, never typed by hand. Platforms already in the
# manifest and not named again are kept, with their files.
#
# The manifest is replaced in one rename, so the page never reads half a file. Serve the
# folder with docker-compose.downloads.yml.
set -eu

die() { echo "publish-downloads: $*" >&2; exit 1; }
[ $# -ge 2 ] || die "usage: publish-downloads.sh <downloads-dir> <platform>=<file>[@<version>] ..."

DIR=$1
shift
mkdir -p "$DIR"
PY=$(command -v python3 || command -v python) || die "python3 is needed to write the manifest"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

entries=""
for arg in "$@"; do
  platform=${arg%%=*}
  rest=${arg#*=}
  [ "$platform" != "$arg" ] || die "expected <platform>=<file>, got '$arg'"
  case "$platform" in android|windows|macos|linux) ;; *) die "unknown platform '$platform'" ;; esac
  case "$rest" in *@*) src=${rest%@*}; version=${rest##*@} ;; *) src=$rest; version=unknown ;; esac
  [ -f "$src" ] || die "no file $src"
  name=$(basename "$src")
  case "$name" in *[!A-Za-z0-9._+-]*) die "file name '$name' has characters a link cannot carry safely" ;; esac
  case "$version" in *[!A-Za-z0-9._+-]*|'') die "version '$version' is not plain text" ;; esac
  cp "$src" "$DIR/$name.tmp" && mv "$DIR/$name.tmp" "$DIR/$name"
  size=$(wc -c < "$DIR/$name" | tr -d ' ')
  sum=$(sha256_of "$DIR/$name")
  entries="$entries$platform $version $name $size $sum
"
  echo "published $platform $version: $name ($size bytes, sha256 $sum)"
done

printf '%s' "$entries" | "$PY" -I -c '
import json, os, sys
d = sys.argv[1]
path = os.path.join(d, "manifest.json")
apps = {}
if os.path.exists(path):
    try:
        for a in json.load(open(path)).get("apps", []):
            apps[a["platform"]] = a
    except (ValueError, KeyError, AttributeError):
        apps = {}
for line in sys.stdin.read().splitlines():
    platform, version, name, size, sha = line.split(" ")
    apps[platform] = {"platform": platform, "version": version, "file": name,
                      "size_bytes": int(size), "sha256": sha}
order = ["android", "windows", "macos", "linux"]
out = {"apps": [apps[p] for p in order if p in apps]}
tmp = path + ".tmp"
with open(tmp, "w") as f:
    json.dump(out, f, indent=2)
    f.write("\n")
os.replace(tmp, path)
print("wrote %s (%d apps)" % (path, len(out["apps"])))
' "$DIR"
