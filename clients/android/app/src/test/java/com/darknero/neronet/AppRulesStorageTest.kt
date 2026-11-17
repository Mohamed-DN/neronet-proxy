package com.darknero.neronet

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.tunnel.AppRuleMode
import com.darknero.neronet.tunnel.AppRules
import com.darknero.neronet.tunnel.TunnelConfigs
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Base64

/** Split tunnelling lives on the device, never in the profile file (ADR 0035). */
@RunWith(AndroidJUnit4::class)
class AppRulesStorageTest {

    private val context: Context = ApplicationProvider.getApplicationContext()
    private val dir = File(context.cacheDir, "profiles-apprules-test")

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private val text = "# NeroNet-Profile: 1\n# NeroNet-Console: https://console.example.com\n" +
        "[Interface]\nPrivateKey = ${fakeKey(1)}\nAddress = 100.64.12.34/32\n" +
        "[Peer]\nPublicKey = ${fakeKey(50)}\nEndpoint = gateway.example:51820\nAllowedIPs = 0.0.0.0/0\n"

    @Before
    fun clean() {
        dir.deleteRecursively()
        context.getSharedPreferences("neronet_settings", Context.MODE_PRIVATE).edit().clear().commit()
    }

    @Test
    fun settingTheRulesDoesNotTouchTheProfileFile() {
        val settings = SettingsStore(context.getSharedPreferences("neronet_settings", Context.MODE_PRIVATE))
        val repository = ProfileRepository(ProfileStore(dir), settings)
        val id = repository.add(text)
        val file = File(dir, "$id.conf")
        val before = file.readBytes()

        settings.setAppRules(id, AppRules(AppRuleMode.INCLUDE_ONLY, setOf("org.example.mail")))
        settings.setKillSwitch(id, false)
        repository.refresh()

        assertArrayEquals(before, file.readBytes())
        assertEquals(text, file.readText())
        assertFalse(file.readText().contains("org.example.mail"))
        assertFalse(file.readText().contains("Application"))
    }

    @Test
    fun theStoredProfileStaysFreeOfRulesWhileTheTunnelConfigCarriesThem() {
        val settings = SettingsStore(context.getSharedPreferences("neronet_settings", Context.MODE_PRIVATE))
        val repository = ProfileRepository(ProfileStore(dir), settings)
        val id = repository.add(text)
        val rules = AppRules(AppRuleMode.EXCLUDE, setOf("org.example.bank"))
        settings.setAppRules(id, rules)

        val profile = repository.profile(id)!!
        val config = TunnelConfigs.withAppRules(profile.config, settings.appRules(id))

        assertTrue(profile.config.`interface`.excludedApplications.isEmpty())
        assertEquals(setOf("org.example.bank"), config.`interface`.excludedApplications)
    }

    @Test
    fun deletingTheProfileDropsItsRules() {
        val settings = SettingsStore(context.getSharedPreferences("neronet_settings", Context.MODE_PRIVATE))
        val repository = ProfileRepository(ProfileStore(dir), settings)
        val id = repository.add(text)
        settings.setAppRules(id, AppRules(AppRuleMode.EXCLUDE, setOf("org.example.bank")))

        repository.delete(id)

        assertEquals(AppRules.NONE, settings.appRules(id))
    }
}
