# Sourced by the other scripts in this directory; not run on its own.
# POSIX sh. Works from Git Bash on Windows and from any shell on Linux and macOS.
#
# Sets:
#   ENGINE        podman if it is installed, otherwise docker
#   COMPOSE       the compose command for that engine
#   REPO_ROOT     absolute path of the repository, in the shell's own notation
#   HOST_PATH     function: print a path in the notation the engine expects in -v
#   die           function: print a message on stderr and exit 1

die() {
  echo "error: $*" >&2
  exit 1
}

# The caller is the script that sourced this file, so $0 is that script.
_dev_dir=$(cd "$(dirname "$0")" && pwd) || die "cannot resolve the script directory"
REPO_ROOT=${NERONET_REPO_ROOT:-$(cd "$_dev_dir/../.." && pwd)}
unset _dev_dir

if command -v podman >/dev/null 2>&1; then
  ENGINE=podman
elif command -v docker >/dev/null 2>&1; then
  ENGINE=docker
else
  die "neither podman nor docker is installed"
fi
COMPOSE="$ENGINE compose"

# `podman compose` delegates to an external provider and prints a banner about it on
# every call. The banner is noise in the output of these scripts.
export PODMAN_COMPOSE_WARNING_LOGS=false

case "$(uname -s)" in
  MINGW* | MSYS*)
    # Git Bash rewrites any argument that looks like a POSIX path, so `-v x:/src`
    # arrives as `-v x:C:/Program Files/Git/src`. Turn that off, and hand the engine
    # Windows paths, which is what it understands on the host side of -v.
    export MSYS_NO_PATHCONV=1
    HOST_PATH() { (cd "$1" && pwd -W); }
    ;;
  *)
    HOST_PATH() { (cd "$1" && pwd); }
    ;;
esac
