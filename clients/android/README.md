# NeroNet for Android (version 1.0.0)

A profile client for NeroNet, as described in ADR 0029 (`docs/adr/0029-device-apps-and-profile-gateway.md`).
The app imports a NeroNet profile (a standard
`wg-quick` file with `# NeroNet-...` comment lines), brings the tunnel up with the official WireGuard
tunnel library (`com.wireguard.android:tunnel`), and shows what the profile and the handshake prove.

The connection is controlled by the network map: the device node on the map is the switch. The status
is written out in words, and the details panel is quiet. A Quick Settings tile and an ongoing
notification with a Disconnect button cover the rest. The app is distributed outside the Play Store:
our own APK, side-loaded.

## Build and test

Requirements: Podman (rootless) and Git Bash on Windows. No Android SDK or JDK is needed on the host.

```bash
clients/android/build.sh testDebugUnitTest assembleDebug assembleRelease
```

With no arguments the script runs `testDebugUnitTest assembleDebug`. It uses the pinned image
`docker.io/mobiledevops/android-sdk-image:34.0.1`, installs Android platform 35 and build-tools 35.0.0,
and prints the per-class test counts and both APK sizes. Gradle caches go to the named Podman volume
`nn-android-gradle-cache`; the Robolectric Android runtime goes to `nn-android-m2-cache`. If
`NERONET_BUILD_WAIT_FLAG` names a file that exists, the script waits until it is gone.

The script fails when an APK is over budget:

| APK | Budget | Measured in version 1.0.0 |
|---|---|---|
| debug (`app/build/outputs/apk/debug/app-debug.apk`, all ABIs) | 24.0 MB (25165824 bytes) | 23.3 MB (24461338 bytes, with the Allaccio animation) |
| release (`app/build/outputs/apk/release/app-release-unsigned.apk`, R8, arm64-v8a and armeabi-v7a) | 14.0 MB (14680064 bytes) | 8.0 MB (8424106 bytes, with the Allaccio animation) |

Pinned versions: Gradle 8.10.2, Android Gradle Plugin 8.7.3, Kotlin 2.0.21, compileSdk and targetSdk 35,
minSdk 26, Compose BOM 2024.12.01 (Material 3 1.3.1), `activity-compose` 1.9.3,
`com.wireguard.android:tunnel:1.0.20260102`, ZXing Android Embedded 4.3.0, kotlinx.coroutines 1.9.0,
JUnit 4.13.2, Robolectric 4.14.1.

### Why Jetpack Compose and Material 3

The v0 app used Views and Material Components. The signature element, the network map, is a custom
drawing that is also a switch. In Compose it is a canvas with `toggleable(role = Role.Switch)` and a
state description, so TalkBack behaviour is declared rather than hand-built with a virtual-node helper.
Compose UI tests run under Robolectric in the same container, so the semantics (live regions, roles,
touch targets) are asserted in unit tests. The tablet's two-pane layout is one function of the window
size. The cost is about 5 MB of unminified code, which the release build removes with R8.

## Install (side-loading)

1. Copy `app-debug.apk` to the phone, or download it from the console.
2. Open the file. Android asks to allow installs from this source: enable "Install unknown apps"
   (or "Allow from this source") for the app you opened the file with, then go back and install.
3. Open NeroNet, scan the QR code shown in the console (or import the profile file), and tap the
   device on the map. Android asks for VPN permission the first time.

The debug APK is **debug-signed**. The release APK is **unsigned**: it is not installable until our
own release key exists. Updates then need the same key, so do not mix debug and release builds on one device.

## Profiles

- Import by QR code (camera), from a file (Storage Access Framework), or by pasting the profile text.
  Pasting is done in a window that blocks screenshots; a clipboard copy of an imported profile is cleared.
- The same key imported twice selects the existing profile; it is not stored twice.
- The parser follows `pkg/profile/profile.go`: `NeroNet-Profile` must be 1 (or absent for a plain
  WireGuard file), `NeroNet-Console` must be https, and keys such as `PostUp`, `PostDown`, `PreUp`,
  `PreDown`, `Table` and `SaveConfig` are refused, as is any key the app does not know.
- Profiles are kept in the app's private storage. They are not encrypted at rest; the device's private
  key is stored there. Deleting a profile removes its file. Deleting the connected profile disconnects first.
- The app never shows or sends a private key. It makes no network calls of its own; only the WireGuard
  tunnel and the browser (for the console) reach the network.

## Profile options (ADR 0035, phase A)

Options are kept per profile on the device (SharedPreferences), never in the profile file. Open them from the
profile list: the menu of a profile row, then Options.

- **Kill switch.** On by default when a profile sends all traffic through NeroNet (`AllowedIPs` has `0.0.0.0/0`
  or `::/0`), off otherwise. After an unexpected drop the app brings up a VPN interface that routes `0.0.0.0/0`
  and `::/0` to one peer with a random key and no endpoint, so traffic goes nowhere, and retries the real tunnel
  after 3, 6, 12, 24 and then every 30 seconds. Turning the tunnel off ends it. Android's "Block connections
  without VPN" stays recommended: the library replaces the interface in-process, so a gap of a few
  milliseconds is possible when the block starts and when the tunnel returns.
- **Split tunnelling per app.** All apps, only the picked apps, or all except the picked apps, through the
  library's included and excluded application lists. Applies from the next tunnel start. The app list needs
  only a launcher `<queries>` entry, not a broad package permission.
- **Device name.** Optional `# NeroNet-DNS-Name:` comment line, and a search domain after the DNS server
  (`DNS = 100.100.100.100, example.com`). The options screen shows "Reachable as <name>", else the profile title.
- **NeroDrop.** When the profile has `# NeroNet-Console:`, the details panel has a button that opens the
  console's `/drop` page in a Custom Tab (`androidx.browser`). The app adds no fragment and handles no key.

## Tests

| Class | Tests |
|---|---|
| AppRulesStorageTest | 3 |
| ComposeSmokeTest | 1 |
| LicenseCatalogTest | 3 |
| MainActivityTest | 4 |
| NeroDropTest | 5 |
| NeroNetProfileTest | 20 |
| ProfileErrorStringsTest | 4 |
| ProfileImporterTest | 5 |
| ProfileRepositoryTest | 5 |
| ProfileStoreTest | 2 |
| ProfileSummaryTest | 12 |
| SettingsStoreTest | 6 |
| StringsLocaleTest | 2 |
| StringsParityTest | 5 |
| system.ConnectionNotifierTest | 3 |
| system.NotificationModelTest | 2 |
| system.TileModelTest | 11 |
| system.VpnConsentActivityTest | 2 |
| tunnel.KillSwitchRepositoryTest | 6 |
| tunnel.KillSwitchStateMachineTest | 17 |
| tunnel.LinkHealthTest | 5 |
| tunnel.SplitTunnelRepositoryTest | 2 |
| tunnel.TunnelConfigsTest | 11 |
| tunnel.TunnelErrorMappingTest | 8 |
| tunnel.TunnelRepositoryTest | 7 |
| tunnel.TunnelStateMachineTest | 32 |
| ui.LayoutModeTest | 6 |
| ui.NavigationTest | 4 |
| ui.apps.AppPickerModelTest | 4 |
| ui.apps.AppPickerScreenTest | 6 |
| ui.home.DetailsPanelDropTest | 2 |
| ui.home.HomeScreenTest | 9 |
| ui.home.HomeUiStateTest | 19 |
| ui.home.HomeViewModelTest | 2 |
| ui.map.MapGeometryTest | 10 |
| ui.map.MapVisualsTest | 30 |
| ui.map.NetworkMapTest | 8 |
| ui.profiles.PasteProfileScreenTest | 4 |
| ui.profiles.ProfileFileReaderTest | 2 |
| ui.profiles.ProfileOptionsScreenTest | 4 |
| ui.profiles.ProfilesScreenTest | 4 |
| ui.profiles.ProfilesViewModelTest | 2 |
| ui.settings.SettingsScreenTest | 4 |
| ui.theme.PaletteContrastTest | 4 |
| ui.theme.ThemeResourcesTest | 4 |
| **Total** | **311** |

Static checks (run before each release): no `netbird` or `tailscale` text in `app/src/main`; no
`com.google.android.gms`, `firebase` or `analytics` in `app/src/main` or `app/build.gradle.kts`; and
`build.sh :app:dependencies --configuration releaseRuntimeClasspath` lists no `gms` or `firebase`
artifact.

### Release signing (supplied outside the repository)

No keystore, key alias or password is ever committed; `.gitignore` also excludes `*.jks`, `*.keystore` and
`keystore.properties`. When the release key exists, CI will supply it at build time only: the keystore as a
base64 secret decoded to a temporary file, and `NERONET_KEYSTORE_PATH`, `NERONET_KEYSTORE_PASSWORD`,
`NERONET_KEY_ALIAS` and `NERONET_KEY_PASSWORD` as masked environment variables. The release build type will read
those four variables and sign only when all are set; without them the build stays unsigned, as it is today.
Some but not all of the four stops the build.

The workflow `.github/workflows/android.yml` runs the tests and the debug build on every change here, and, started by
hand with "signed release", builds the signed release in the GitHub environment `android-release`. That environment
holds the secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and
`ANDROID_KEY_PASSWORD`; give it a required reviewer, and restrict it to `main`. The job checks that the signing
certificate is the one in `ANDROID_CERT_SHA256` (a public value, an environment variable) before it keeps the APK, so
a wrong key cannot become a release.

To create the key (once, on your own machine, never in a container of ours and never in the repository):

```bash
keytool -genkeypair -v -keystore neronet-release.jks -storetype PKCS12 -keyalg RSA -keysize 4096 -validity 10000 -alias neronet
```

Keep the file and its password in two separate safe places. Losing them means the installed apps can never be
updated again; leaking them means someone else can sign an update.

## Manual checks on the owner's tablet

These need the device; the container cannot run them. Run them on the tablet in landscape and portrait.

- TalkBack reads the device node on the map as a switch, with its state ("Protected", "Not connected").
- At the largest system font size no text is clipped. Map labels disappear by design above font scale 1.3;
  the same facts are in the status sentence and in the details.
- Dark theme: the status colours stay readable, and green appears only with "Protected".
- "Remove animations" (developer options, or the accessibility setting) stops the connect pulse.
- The Quick Settings tile toggles only after the device is unlocked, and the tile's off state shows a slash.
- The notification's Disconnect button works, and the notification disappears when the VPN stops.
- Always-on VPN (Settings, then Open VPN settings) reconnects after a reboot.
- QR import with the camera; camera refusal shows its message.
- Landscape two-pane layout: map and status on the left, profiles and details on the right, no empty middle.

## Limits of version 1.0.0

- No release key yet: the release APK is unsigned and the debug APK is debug-signed. Neither is in a store.
- The app does not reach the mesh directly; it needs a profile gateway (ADR 0029).
- The status shows only what the WireGuard library reports: the traffic counters and the last handshake.
  WireGuard retries every 5 seconds on its own; the app does not schedule retries.
- Profiles are not encrypted at rest.
