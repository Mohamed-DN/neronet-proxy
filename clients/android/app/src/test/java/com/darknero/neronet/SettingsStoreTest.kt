package com.darknero.neronet

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.tunnel.AppRuleMode
import com.darknero.neronet.tunnel.AppRules
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SettingsStoreTest {

    private val context: Context = ApplicationProvider.getApplicationContext()

    private fun prefs() = context.getSharedPreferences("neronet_settings", Context.MODE_PRIVATE)

    @Before
    fun clearPrefs() {
        prefs().edit().clear().commit()
    }

    @Test
    fun themeModeDefaultsToSystemAndPersists() {
        val store = SettingsStore(prefs())
        assertEquals(ThemeMode.SYSTEM, store.themeMode.value)

        store.setThemeMode(ThemeMode.DARK)

        assertEquals(ThemeMode.DARK, SettingsStore(prefs()).themeMode.value)
    }

    @Test
    fun lastProfileIdRoundTrips() {
        val store = SettingsStore(prefs())
        assertNull(store.lastProfileId)

        store.lastProfileId = "abc123def456"

        assertEquals("abc123def456", SettingsStore(prefs()).lastProfileId)
        store.lastProfileId = null
        assertNull(SettingsStore(prefs()).lastProfileId)
    }

    @Test
    fun killSwitchUsesTheDefaultUntilTheChoiceIsMade() {
        val store = SettingsStore(prefs())
        assertEquals(true, store.killSwitch("p1", default = true))
        assertEquals(false, store.killSwitch("p1", default = false))

        store.setKillSwitch("p1", false)

        assertEquals(false, SettingsStore(prefs()).killSwitch("p1", default = true))
        // Another profile is not affected.
        assertEquals(true, SettingsStore(prefs()).killSwitch("p2", default = true))
    }

    @Test
    fun forgettingAProfileBringsBackTheDefault() {
        val store = SettingsStore(prefs())
        store.setKillSwitch("p1", false)

        store.forgetProfile("p1")

        assertEquals(true, store.killSwitch("p1", default = true))
    }

    @Test
    fun appRulesDefaultToNoRuleAndRoundTrip() {
        val store = SettingsStore(prefs())
        assertEquals(AppRules.NONE, store.appRules("p1"))

        val rules = AppRules(AppRuleMode.EXCLUDE, setOf("org.example.bank", "org.example.mail"))
        store.setAppRules("p1", rules)

        assertEquals(rules, SettingsStore(prefs()).appRules("p1"))
        assertEquals(AppRules.NONE, SettingsStore(prefs()).appRules("p2"))
    }

    @Test
    fun forgettingAProfileDropsItsAppRules() {
        val store = SettingsStore(prefs())
        store.setAppRules("p1", AppRules(AppRuleMode.INCLUDE_ONLY, setOf("org.example.mail")))

        store.forgetProfile("p1")

        assertEquals(AppRules.NONE, store.appRules("p1"))
    }
}
