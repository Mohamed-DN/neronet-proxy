#!/usr/bin/env bash
# Builds the debug APK and runs the JVM unit tests inside a rootless Podman container.
# Usage: clients/android/build.sh [gradle tasks...]   (default: testDebugUnitTest assembleDebug)
set -euo pipefail

# Pinned public Android SDK image (JDK 17, Android SDK under /opt/android-sdk-linux).
IMAGE="docker.io/mobiledevops/android-sdk-image:34.0.1"
# Gradle caches live in a named volume of our own, so rebuilds do not re-download everything.
GRADLE_CACHE_VOLUME="nn-android-gradle-cache"
# Heavy builds wait while a timing-sensitive network test holds this flag file.
DERP_FLAG="C:/AI/NeroNet/piano/reports/logs-t0p1/DERP_RUNNING"

HERE="$(cd "$(dirname "$0")" && pwd)"
# Host path of the worktree root (Windows form under Git Bash, plain path elsewhere).
REPO="$(cd "$HERE/../.." && (pwd -W 2>/dev/null || pwd))"
APP_DIR="$HERE/app"
APK="$APP_DIR/build/outputs/apk/debug/app-debug.apk"
TASKS=("$@")
if [ "${#TASKS[@]}" -eq 0 ]; then
  TASKS=(testDebugUnitTest assembleDebug)
fi

# Git Bash must not rewrite the container paths (/w, /root/.gradle).
export MSYS_NO_PATHCONV=1

while [ -e "$DERP_FLAG" ]; do
  echo "Waiting: $DERP_FLAG exists (a network test is running). Checking again in 60 s."
  sleep 60
done

echo "Image: $IMAGE"
echo "Worktree mounted at /w from: $REPO"
podman run --rm \
  -v "$REPO:/w" \
  -v "$GRADLE_CACHE_VOLUME:/root/.gradle" \
  -w /w/clients/android \
  --entrypoint /bin/bash \
  "$IMAGE" \
  -c 'set -euo pipefail
      export ANDROID_HOME=/opt/android-sdk-linux ANDROID_SDK_ROOT=/opt/android-sdk-linux
      SDKMANAGER="$ANDROID_HOME/cmdline-tools/bin/sdkmanager --sdk_root=$ANDROID_HOME"
      yes | $SDKMANAGER --licenses >/dev/null 2>&1 || true
      $SDKMANAGER --install "platforms;android-35" "build-tools;35.0.0" >/dev/null
      sh ./gradlew --no-daemon --console=plain '"${TASKS[*]}"

echo
echo "Unit test results:"
for f in "$APP_DIR"/build/test-results/testDebugUnitTest/*.xml; do
  [ -e "$f" ] || continue
  grep -o '<testsuite name="[^"]*" tests="[0-9]*" skipped="[0-9]*" failures="[0-9]*" errors="[0-9]*"' "$f" || true
done

if [ -f "$APK" ]; then
  echo
  echo "APK: $APK"
  ls -l "$APK" | awk '{ printf "Size: %.1f MB (%d bytes)\n", $5/1048576, $5 }'
fi
