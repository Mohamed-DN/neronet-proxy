#!/bin/sh
# Carve packages out of an upstream Go module into third_party/<project>/.
#
# Usage: scripts/thirdparty/carve.sh <project> <upstream-clone> [--commit <sha>]
#
# <project> selects scripts/thirdparty/<project>.conf, which names the upstream
# module, the root packages, the packages whose tests are carried along and the
# shims (upstream import path -> package of ours that replaces it).
#
# What it does, and nothing else:
#   1. asserts the upstream clone is clean and (with --commit) at that commit;
#   2. builds the import graph of the upstream module for each GOOS in CARVE_GOOS
#      (one `go list -e ./...` per GOOS, run in a golang container when the host
#      has no Go) and walks it from the roots, stopping at shims;
#   3. copies every package in that closure verbatim (all files of the package
#      directory, plus testdata for packages whose tests are carried);
#   4. rewrites the import paths of the upstream module to third_party/<project>/
#      and the shimmed paths to their replacements, then runs gofmt so that the
#      import blocks stay sorted. No other change is made to any carved file;
#   5. copies the licence files, writes CARVE_MANIFEST.txt, and pins the external
#      modules the closure imports to the versions the upstream go.mod resolves.
#
# It is repeatable: run it again against another upstream commit and the diff of
# third_party/<project>/ is the upstream diff plus the changed import lines.
# Carved files are never edited by hand; adaptations live in pkg/transplant.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=${CARVE_REPO:-$(cd "$HERE/../.." && pwd)}
PROJECT=${1:?project name (scripts/thirdparty/<project>.conf)}
UPSTREAM=${2:?path of the upstream clone}
COMMIT=""
if [ "${3:-}" = "--commit" ]; then COMMIT=${4:?sha}; fi

# shellcheck disable=SC1090
. "$HERE/$PROJECT.conf"
: "${UP_MODULE:?}" "${ROOTS:?}" "${CARVE_GOOS:=linux windows}" "${GO_IMAGE:=docker.io/library/golang:1.27}"
: "${ALL_TESTS:=0}" "${TEST_ROOTS:=$ROOTS}" "${SHIMS:=}" "${LICENSE_FILES:=LICENSE}" "${ENGINE:=podman}"
OUR_MODULE=$(sed -n 's/^module //p' "$REPO/go.mod")
DEST="$REPO/third_party/$PROJECT"
NEWBASE="$OUR_MODULE/third_party/$PROJECT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

export MSYS_NO_PATHCONV=1
winpath() { (cd "$1" && (pwd -W 2>/dev/null || pwd)); }
REPO_W=$(winpath "$REPO")
UP_W=$(winpath "$UPSTREAM")

# gorun <workdir-in-container> <command...>: run a shell command with Go available.
gorun() {
  wd=$1; shift
  if command -v go >/dev/null 2>&1 && [ "${CARVE_HOST_GO:-0}" = 1 ]; then
    (cd "$wd" && sh -c "$*")
  else
    $ENGINE run --rm --name "carve-$PROJECT-$$" \
      -v "$UP_W:/up:ro" -v "$REPO_W:/work" \
      -v neronet-gomod:/go/pkg/mod -v neronet-gocache:/root/.cache/go-build \
      -e GOTOOLCHAIN=local -e GOFLAGS=-mod=mod -w "$wd" "$GO_IMAGE" sh -c "$*"
  fi
}

# 1. upstream state
have=$(git -C "$UP_W" rev-parse HEAD)
if [ -n "$COMMIT" ] && [ "$have" != "$COMMIT" ]; then
  echo "upstream is at $have, expected $COMMIT" >&2; exit 1
fi
if [ -n "$(git -C "$UP_W" status --porcelain)" ]; then
  echo "upstream clone is not clean" >&2; exit 1
fi
COMMIT=$have

# 2. graph. One line per package: import path, dir relative to the module root,
#    imports, test imports (in-package and external).
: > "$WORK/graph.tsv"
for os in $CARVE_GOOS; do
  gorun /up "GOFLAGS= GOOS=$os GOARCH=amd64 go list -e -f '{{.ImportPath}}	{{.Dir}}	{{join .Imports \" \"}}	{{join .TestImports \" \"}}	{{join .XTestImports \" \"}}	{{join .EmbedFiles \" \"}}	{{join .TestEmbedFiles \" \"}} {{join .XTestEmbedFiles \" \"}}' ./..." \
    >> "$WORK/graph.tsv"
done
awk -F'\t' -v OFS='\t' '{ d=$2; if (d=="/up") d="."; else sub(/^\/up\//, "", d); $2=d; print }' \
  "$WORK/graph.tsv" > "$WORK/graph2.tsv"
mv "$WORK/graph2.tsv" "$WORK/graph.tsv"

roots=""
for r in $ROOTS; do roots="$roots $UP_MODULE/${r#./}"; done
troots=""
for r in $TEST_ROOTS; do troots="$troots $UP_MODULE/${r#./}"; done
shimfrom=""
for s in $SHIMS; do shimfrom="$shimfrom ${s%%=*}"; done

awk -F'\t' -v mod="$UP_MODULE" -v roots="$roots" -v troots="$troots" -v alltests="$ALL_TESTS" -v shims="$shimfrom" '
  { pkg=$1; dir[pkg]=$2; imp[pkg]=imp[pkg] " " $3; timp[pkg]=timp[pkg] " " $4 " " $5; emb[pkg]=emb[pkg] " " $6; temb[pkg]=temb[pkg] " " $7 }
  END {
    n=split(shims, sh, " "); for (i=1;i<=n;i++) shim[sh[i]]=1
    n=split(troots, tr, " "); for (i=1;i<=n;i++) tr_[tr[i]]=1
    n=split(roots, rt, " "); qn=0
    for (i=1;i<=n;i++) { q[++qn]=rt[i]; seen[rt[i]]=1 }
    for (i=1;i<=n;i++) if (!(rt[i] in dir)) { print "MISSING\t" rt[i] }
    for (h=1; h<=qn; h++) {
      p=q[h]
      list=imp[p]; if (alltests==1 || (p in tr_)) { list=list " " timp[p]; want[p]=1 }
      m=split(list, l, " ")
      for (j=1;j<=m;j++) {
        d=l[j]
        if (d=="" || d=="C" || d=="unsafe") continue
        if (d in shim) { usedshim[d]=1; continue }
        if (d==mod || index(d, mod "/")==1) {
          if (!(d in seen)) { seen[d]=1; q[++qn]=d }
        } else if (index(d, ".")>0 && index(d,"/")>0 && substr(d,1,index(d,"/")-1) ~ /\./) {
          ext[d]=1
        }
      }
    }
    for (p in seen) {
      printf "PKG\t%s\t%s\t%s\n", p, dir[p], (alltests==1 || (p in tr_)) ? "T" : "-"
      el=emb[p]; if (alltests==1 || (p in tr_)) el=el " " temb[p]
      m=split(el, e, " ")
      for (j=1;j<=m;j++) if (!((p SUBSEP e[j]) in doneemb)) { doneemb[p,e[j]]=1; printf "EMB\t%s\t%s\n", dir[p], e[j] }
    }
    for (d in ext) print "EXT\t" d
    for (d in usedshim) print "SHIM\t" d
  }' "$WORK/graph.tsv" | sort > "$WORK/closure.txt"

if grep '^MISSING' "$WORK/closure.txt"; then echo "root package not found upstream" >&2; exit 1; fi
npk=$(grep -c '^PKG' "$WORK/closure.txt")
echo "closure: $npk packages"
if [ "${CLOSURE_ONLY:-0}" = 1 ]; then
  lines=0
  for d in $(grep "^PKG" "$WORK/closure.txt" | cut -f3); do
    n=$(ls "$UPSTREAM/$d"/*.go 2>/dev/null | grep -v _test.go | xargs cat 2>/dev/null | wc -l); lines=$((lines+n))
  done
  echo "non-test go lines (all GOOS files): $lines"; grep "^EXT" "$WORK/closure.txt" | cut -f2; exit 0
fi

# 3. copy
rm -rf "$DEST"
mkdir -p "$DEST"
grep '^PKG' "$WORK/closure.txt" | while IFS='	' read -r _ pkg dir tst; do
  out="$DEST/$dir"
  mkdir -p "$out"
  for f in "$UPSTREAM/$dir"/*; do
    [ -f "$f" ] || continue
    b=$(basename "$f")
    case "$b" in go.mod|go.sum|go.work|go.work.sum) continue ;; esac
    if [ "$dir" = . ]; then case "$b" in *.go) ;; *) continue ;; esac; fi
    case "$b" in
      *_test.go) [ "$tst" = T ] || continue ;;
    esac
    cp "$f" "$out/$b"
  done
  if [ "$tst" = T ] && [ -d "$UPSTREAM/$dir/testdata" ]; then
    cp -r "$UPSTREAM/$dir/testdata" "$out/testdata"
  fi
done
# files named by //go:embed, which may sit in subdirectories that are not packages
grep '^EMB' "$WORK/closure.txt" | while IFS='	' read -r _ dir f; do
  mkdir -p "$DEST/$dir/$(dirname "$f")"
  cp "$UPSTREAM/$dir/$f" "$DEST/$dir/$f"
done
for lf in $LICENSE_FILES; do
  [ -f "$UPSTREAM/$lf" ] && cp "$UPSTREAM/$lf" "$DEST/$lf"
done

# 4. import path rewrite. Only import lines are touched: an optional alias, then
#    the quoted path, with nothing but a comment after it.
pre='^([[:space:]]*(import[[:space:]]+)?([A-Za-z_.][A-Za-z0-9_]*[[:space:]]+)?)'
post='([[:space:]]*(//.*)?)$'
for s in $SHIMS; do
  from=$(printf '%s' "${s%%=*}" | sed 's/\./\\./g'); to=${s#*=}
  find "$DEST" -name '*.go' -exec sed -E -i "s#${pre}\"${from}\"${post}#\\1\"${to}\"\\4#" {} +
done
modre=$(printf '%s' "$UP_MODULE" | sed 's/\./\\./g')
find "$DEST" -name '*.go' -exec sed -E -i \
  "s#${pre}\"${modre}(/[^\"]*)?\"${post}#\\1\"${NEWBASE}\\4\"\\5#" {} +
gorun /work "gofmt -w third_party/$PROJECT"

# 5. manifest and module requirements
{
  echo "project: $PROJECT"
  echo "upstream module: $UP_MODULE"
  echo "upstream commit: $COMMIT"
  echo "goos considered: $CARVE_GOOS"
  echo "roots:$roots"
  echo "test roots:$troots"
  echo "shims: $SHIMS"
  echo "packages: $npk"
  grep '^PKG' "$WORK/closure.txt" | awk -F'\t' '{print "  " $2 " " $4}'
  echo "external imports:"
  grep '^EXT' "$WORK/closure.txt" | awk -F'\t' '{print "  " $2}'
} > "$DEST/CARVE_MANIFEST.txt"

# External modules: pin to the versions the upstream go.mod resolves, so that the
# carved code is built against what upstream tested it with.
gorun /up "GOFLAGS= go list -m -f '{{.Path}} {{.Version}}' all" > "$WORK/upmods.txt"
grep '^EXT' "$WORK/closure.txt" | awk -F'\t' '{print $2}' | awk -v modsf="$WORK/upmods.txt" '
  BEGIN { while ((getline line < modsf) > 0) { split(line, a, " "); mods[a[1]]=a[2] } }
  { best=""; for (m in mods) if ((index($0, m "/")==1 || $0==m) && length(m)>length(best)) best=m
    if (best!="" && mods[best]!="") print best "@" mods[best] }' | sort -u > "$WORK/require.txt"
cp "$WORK/require.txt" "$DEST/REQUIRE.txt"
gorun /work "for r in \$(cat third_party/$PROJECT/REQUIRE.txt); do go get \$r || exit 1; done; go mod tidy"
echo "carved $npk packages into third_party/$PROJECT at $COMMIT"
