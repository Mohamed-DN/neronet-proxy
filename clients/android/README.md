# NeroNet for Android (version 0)

A profile client for NeroNet, as described in ADR 0029 (`docs/adr/0029-device-apps-and-profile-gateway.md`).
The app imports a NeroNet profile (a standard `wg-quick` file with `# NeroNet-...` comment lines),
brings the tunnel up with the official WireGuard tunnel library (`com.wireguard.android:tunnel`),
and opens the console from the profile's `NeroNet-Console` address.

The app is distributed outside the Play Store: our own APK, side-loaded.

## Build and test

Requirements: Podman (rootless) and Git Bash on Windows. No Android SDK or JDK is needed on the host.

```bash
clients/android/build.sh
```

The script runs the pinned image `docker.io/mobiledevops/android-sdk-image:34.0.1` in a container,
installs Android platform 35 and build-tools 35.0.0, then runs:

```
sh ./gradlew --no-daemon testDebugUnitTest assembleDebug
```

The debug APK is written to `clients/android/app/build/outputs/apk/debug/app-debug.apk`
(gitignored). Gradle caches go to the named Podman volume `nn-android-gradle-cache`.
If `DERP_RUNNING` exists under `piano/reports/logs-t0p1/`, the script waits until it is gone.

Pinned versions: Gradle 8.10.2, Android Gradle Plugin 8.7.3, Kotlin 2.0.21, compileSdk and
targetSdk 35, minSdk 26, `com.wireguard.android:tunnel:1.0.20260102`, AppCompat 1.7.0, JUnit 4.13.2.

## Install (side-loading)

1. Copy `app-debug.apk` to the phone, or download it from the console.
2. Open the file. Android asks to allow installs from this source: enable "Install unknown apps"
   (or "Allow from this source") for the app you opened the file with, then go back and install.
3. Open NeroNet, import a profile, and turn on "Connect VPN". Android asks for VPN permission the first time.

The APK is **debug-signed**. Android accepts it, but it is not a release build. It will be signed
with our own release key once that key exists; updates then need the same key, so do not mix the
debug and release builds on one device.

## Profiles

- Import from a file (Storage Access Framework) or paste the profile text.
- The parser follows `pkg/profile/profile.go`: `NeroNet-Profile` must be 1 (or absent for a plain
  WireGuard file), `NeroNet-Console` must be https, and keys such as `PostUp`, `PostDown`, `PreUp`,
  `PreDown`, `Table` and `SaveConfig` are refused, as is any key the app does not know.
- Profiles are kept in the app's private storage. In version 0 they are not encrypted at rest;
  the device's private key is stored there. Delete a profile to remove it from the device.
- The app never sends a private key anywhere.

## Limits of version 0

- QR import is not implemented yet.
- The app does not connect to the mesh directly; it needs a profile gateway (ADR 0029).
- Status shows the traffic counters and the last handshake reported by the WireGuard library.
- The APK is not signed for release and is not in any store.

## Tests

`app/src/test/java/com/darknero/neronet/NeroNetProfileTest.kt` covers the parser rules with fake
keys generated in the test. Their results are printed by `build.sh`.
