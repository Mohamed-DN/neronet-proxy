package com.darknero.neronet

import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

enum class ThemeMode { SYSTEM, LIGHT, DARK }

/** Small preferences the app keeps between launches. Nothing secret is stored here. */
class SettingsStore(private val prefs: SharedPreferences) {

    private val theme = MutableStateFlow(readTheme())
    val themeMode: StateFlow<ThemeMode> = theme.asStateFlow()

    fun setThemeMode(mode: ThemeMode) {
        prefs.edit().putString(KEY_THEME, mode.name).apply()
        theme.value = mode
    }

    /** The profile the user last selected or connected; the always-on VPN and the tile use it. */
    var lastProfileId: String?
        get() = prefs.getString(KEY_LAST_PROFILE, null)
        set(value) {
            prefs.edit().putString(KEY_LAST_PROFILE, value).apply()
        }

    /** True once the notification permission has been asked for, so it is asked only once. */
    var notificationsAsked: Boolean
        get() = prefs.getBoolean(KEY_NOTIFICATIONS_ASKED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_NOTIFICATIONS_ASKED, value).apply()
        }

    /**
     * The kill switch of one profile (ADR 0035). The person's choice if there is one, else [default],
     * which callers set to "on" for full-tunnel profiles. Kept on this device only.
     */
    fun killSwitch(profileId: String, default: Boolean): Boolean =
        prefs.getBoolean(KEY_KILL_SWITCH + profileId, default)

    fun setKillSwitch(profileId: String, enabled: Boolean) {
        prefs.edit().putBoolean(KEY_KILL_SWITCH + profileId, enabled).apply()
    }

    /** Forgets every per-profile choice; called when the profile is deleted. */
    fun forgetProfile(profileId: String) {
        prefs.edit().remove(KEY_KILL_SWITCH + profileId).apply()
    }

    private fun readTheme(): ThemeMode =
        runCatching { ThemeMode.valueOf(prefs.getString(KEY_THEME, null) ?: "") }
            .getOrDefault(ThemeMode.SYSTEM)

    companion object {
        const val PREFS_NAME = "neronet_settings"
        private const val KEY_THEME = "theme_mode"
        private const val KEY_LAST_PROFILE = "last_profile_id"
        private const val KEY_NOTIFICATIONS_ASKED = "notifications_asked"
        private const val KEY_KILL_SWITCH = "kill_switch_"
    }
}
