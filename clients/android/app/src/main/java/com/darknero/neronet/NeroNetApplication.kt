package com.darknero.neronet

import android.app.Application
import android.content.Context
import java.io.File
import com.darknero.neronet.system.ConnectionNotifier
import com.darknero.neronet.tunnel.Clock
import com.darknero.neronet.tunnel.GoTunnelEngine
import com.darknero.neronet.tunnel.SystemClockSource
import com.darknero.neronet.tunnel.TunnelEngine
import com.darknero.neronet.tunnel.TunnelRepository
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * The app graph. The tunnel engine is built on first use of [tunnels]: GoBackend loads a native library
 * that does not exist on the JVM, so unit tests replace [createEngine] and never reach it.
 */
open class NeroNetApplication : Application() {

    val applicationScope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    lateinit var settings: SettingsStore
        private set
    lateinit var profiles: ProfileRepository
        private set

    val tunnels: TunnelRepository by lazy {
        TunnelRepository(
            engine = createEngine(),
            profileLookup = { id -> profiles.profile(id) },
            clock = clock,
            scope = applicationScope,
        )
    }

    private val clock: Clock = SystemClockSource

    override fun onCreate() {
        super.onCreate()
        settings = SettingsStore(getSharedPreferences(SettingsStore.PREFS_NAME, Context.MODE_PRIVATE))
        profiles = ProfileRepository(ProfileStore(File(filesDir, "profiles")), settings)
        ConnectionNotifier(this, tunnels, profiles, applicationScope).start()
    }

    protected open fun createEngine(): TunnelEngine =
        GoTunnelEngine(this) { tunnels.alwaysOnStarted(settings.lastProfileId) }

    companion object {
        fun from(context: Context): NeroNetApplication = context.applicationContext as NeroNetApplication
    }
}
