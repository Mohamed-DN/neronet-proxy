package com.darknero.neronet.ui

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.net.VpnService
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.union
import androidx.compose.material3.Surface
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier as ComposeModifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.core.content.pm.PackageInfoCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import com.darknero.neronet.AddMethod
import com.darknero.neronet.ImportResult
import com.darknero.neronet.NeroNetApplication
import com.darknero.neronet.ui.profiles.ProfileFileReader
import com.darknero.neronet.R
import com.darknero.neronet.tunnel.TunnelPhase
import com.darknero.neronet.ui.home.ErrorAction
import com.darknero.neronet.ui.home.HomeScreen
import com.darknero.neronet.ui.home.HomeViewModel
import com.darknero.neronet.ui.profiles.AddProfileScreen
import com.darknero.neronet.ui.profiles.PasteProfileScreen
import com.darknero.neronet.ui.profiles.ProfilesScreen
import com.darknero.neronet.ui.profiles.ProfilesViewModel
import com.darknero.neronet.ui.profiles.importResultMessage
import com.darknero.neronet.ui.profiles.rememberQrScanner
import com.darknero.neronet.ui.settings.LicensesScreen
import com.darknero.neronet.ui.settings.SettingsScreen
import com.darknero.neronet.system.openVpnSettings
import kotlinx.coroutines.launch

private const val POST_NOTIFICATIONS = "android.permission.POST_NOTIFICATIONS"

/**
 * The whole app below the theme: routes, the home screen, the profile screens, the VPN consent and the
 * notification permission. Two-pane tablets show the profile screens in the right pane of the home screen.
 */
@Composable
fun NeroNetRoot(app: NeroNetApplication) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    val nav = rememberSaveable(saver = NavState.Saver) { NavState() }
    val homeVm: HomeViewModel = viewModel(factory = HomeViewModel.factory(app))
    val profilesVm: ProfilesViewModel = viewModel(factory = ProfilesViewModel.factory(app))

    val home by homeVm.uiState.collectAsStateWithLifecycle()
    val profiles by profilesVm.profiles.collectAsStateWithLifecycle()
    val selected by profilesVm.selectedId.collectAsStateWithLifecycle()
    val active by profilesVm.activeId.collectAsStateWithLifecycle()
    val lastImport by profilesVm.lastImport.collectAsStateWithLifecycle()
    val tunnel by app.tunnels.state.collectAsStateWithLifecycle()
    val themeMode by app.settings.themeMode.collectAsStateWithLifecycle()

    val config = LocalConfiguration.current
    val layout = LayoutMode.of(config.screenWidthDp, config.screenHeightDp)
    val packageInfo = remember(context) { context.packageManager.getPackageInfo(context.packageName, 0) }

    /** A short message at the bottom. Launched in the scope, so it is not cancelled by later state changes. */
    fun say(message: String) {
        scope.launch { snackbar.showSnackbar(message) }
    }

    // True while the last import came from the paste screen, which shows its failure under the field.
    var pasteSubmitted by remember { mutableStateOf(false) }
    val importMessage = lastImport?.let { importResultMessage(it) }
    LaunchedEffect(lastImport) {
        val result = lastImport ?: return@LaunchedEffect
        val success = result is ImportResult.Imported || result is ImportResult.Duplicate
        if (success) nav.popTo(Route.HOME)
        if (pasteSubmitted && !success) return@LaunchedEffect
        pasteSubmitted = false
        profilesVm.consumeImportResult()
        importMessage?.let { say(it) }
    }

    // VPN consent: the system asks once per app; the connection starts only after OK.
    val consentLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == Activity.RESULT_OK) homeVm.onToggle(true) else homeVm.onPermissionDenied()
    }
    fun connectWithConsent() {
        val consent = VpnService.prepare(context)
        if (consent == null) homeVm.onToggle(true) else consentLauncher.launch(consent)
    }

    // Notification permission: asked once, the first time a connection succeeds while the app is open.
    val notificationsLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    val connected = tunnel.phase is TunnelPhase.Connected
    LaunchedEffect(connected) {
        val needsAsk = Build.VERSION.SDK_INT >= 33 &&
            !app.settings.notificationsAsked &&
            ContextCompat.checkSelfPermission(context, POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        if (connected && needsAsk) {
            app.settings.notificationsAsked = true
            notificationsLauncher.launch(POST_NOTIFICATIONS)
        }
    }

    val scanQr = rememberQrScanner { contents, cameraDenied ->
        when {
            cameraDenied -> say(context.getString(R.string.qr_camera_denied))
            contents != null -> {
                pasteSubmitted = false
                profilesVm.import(contents, AddMethod.QR)
            }
        }
    }
    val importFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) {
            val text = ProfileFileReader.read(context.contentResolver, uri)
            if (text == null) {
                say(context.getString(R.string.read_failed))
            } else {
                pasteSubmitted = false
                profilesVm.import(text, AddMethod.FILE)
            }
        }
    }

    val onToggle: (Boolean) -> Unit = { on -> if (on) connectWithConsent() else homeVm.onToggle(false) }
    val onErrorAction: (ErrorAction) -> Unit = { action ->
        when (action) {
            ErrorAction.RETRY -> connectWithConsent()
            ErrorAction.OPEN_VPN_SETTINGS ->
                if (!openVpnSettings(context)) say(context.getString(R.string.vpn_settings_unavailable))
            ErrorAction.CHOOSE_PROFILE -> nav.push(Route.PROFILES)
            ErrorAction.ADD_PROFILE -> nav.push(Route.ADD_PROFILE)
        }
    }
    val onAdd: (AddMethod) -> Unit = { method ->
        when (method) {
            AddMethod.QR -> scanQr()
            AddMethod.FILE -> importFile.launch(arrayOf("*/*"))
            AddMethod.PASTE -> nav.push(Route.PASTE_PROFILE)
        }
    }
    val onCopyAddress: (String) -> Unit = { address ->
        context.getSystemService(ClipboardManager::class.java)
            ?.setPrimaryClip(ClipData.newPlainText(context.getString(R.string.details_address), address))
        // Android 13 and later show their own confirmation for copied text.
        if (Build.VERSION.SDK_INT <= 32) say(context.getString(R.string.details_address_copied))
    }
    val onOpenConsole: (String) -> Unit = { url ->
        if (!url.startsWith("https://")) {
            say(context.getString(R.string.console_not_https))
        } else {
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
            } catch (e: ActivityNotFoundException) {
                say(context.getString(R.string.no_browser))
            }
        }
    }
    val onPasteImport: (String) -> Unit = { text ->
        pasteSubmitted = true
        profilesVm.import(text, AddMethod.PASTE)
    }

    val fullScreenModifier = ComposeModifier.windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))

    val profilesContent: @Composable (ComposeModifier, (() -> Unit)?) -> Unit = { modifier, back ->
        ProfilesScreen(
            profiles = profiles,
            selectedId = selected,
            activeId = active,
            onSelect = profilesVm::select,
            onDelete = profilesVm::delete,
            onAdd = { nav.push(Route.ADD_PROFILE) },
            onBack = back,
            modifier = modifier,
        )
    }
    val addContent: @Composable (ComposeModifier, (() -> Unit)?) -> Unit = { modifier, back ->
        AddProfileScreen(
            onScanQr = scanQr,
            onImportFile = { importFile.launch(arrayOf("*/*")) },
            onPaste = { nav.push(Route.PASTE_PROFILE) },
            onBack = back,
            modifier = modifier,
        )
    }
    val pasteContent: @Composable (ComposeModifier, () -> Unit) -> Unit = { modifier, back ->
        PasteProfileScreen(
            result = lastImport,
            onImport = onPasteImport,
            onBack = back,
            modifier = modifier,
        )
    }

    Surface(ComposeModifier.fillMaxSize()) {
        BackHandler(enabled = nav.current != Route.HOME) { nav.pop() }
        Box(ComposeModifier.fillMaxSize()) {
            when {
                nav.current == Route.SETTINGS -> SettingsScreen(
                    themeMode = themeMode,
                    onThemeChange = { app.settings.setThemeMode(it) },
                    onOpenVpnSettings = { openVpnSettings(context) },
                    onOpenLicenses = { nav.push(Route.LICENSES) },
                    versionName = packageInfo.versionName.orEmpty(),
                    versionCode = PackageInfoCompat.getLongVersionCode(packageInfo).toInt(),
                    onBack = { nav.pop() },
                )
                nav.current == Route.LICENSES -> LicensesScreen(onBack = { nav.pop() })
                layout == LayoutMode.TWO_PANE -> HomeScreen(
                    state = home,
                    layout = layout,
                    onToggle = onToggle,
                    onCancel = homeVm::onCancel,
                    onErrorAction = onErrorAction,
                    onDismissError = homeVm::onDismissError,
                    onOpenConsole = onOpenConsole,
                    onCopyAddress = onCopyAddress,
                    onAdd = onAdd,
                    onProfiles = { nav.push(Route.PROFILES) },
                    onSettings = { nav.push(Route.SETTINGS) },
                    secondaryPane = {
                        when (nav.current) {
                            Route.ADD_PROFILE -> addContent(ComposeModifier, { nav.pop() })
                            Route.PASTE_PROFILE -> pasteContent(ComposeModifier, { nav.pop() })
                            else -> profilesContent(ComposeModifier, null)
                        }
                    },
                )
                nav.current == Route.HOME -> HomeScreen(
                    state = home,
                    layout = layout,
                    onToggle = onToggle,
                    onCancel = homeVm::onCancel,
                    onErrorAction = onErrorAction,
                    onDismissError = homeVm::onDismissError,
                    onOpenConsole = onOpenConsole,
                    onCopyAddress = onCopyAddress,
                    onAdd = onAdd,
                    onProfiles = { nav.push(Route.PROFILES) },
                    onSettings = { nav.push(Route.SETTINGS) },
                    secondaryPane = {},
                )
                nav.current == Route.PROFILES -> profilesContent(fullScreenModifier) { nav.pop() }
                nav.current == Route.ADD_PROFILE -> addContent(fullScreenModifier) { nav.pop() }
                else -> pasteContent(fullScreenModifier) { nav.pop() }
            }
            SnackbarHost(
                hostState = snackbar,
                modifier = ComposeModifier
                    .align(Alignment.BottomCenter)
                    .windowInsetsPadding(WindowInsets.navigationBars.union(WindowInsets.ime))
                    .padding(16.dp),
            )
        }
    }
}
