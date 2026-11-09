package com.darknero.neronet

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
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
}
