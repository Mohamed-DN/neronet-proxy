package com.darknero.neronet

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Base64

@RunWith(AndroidJUnit4::class)
class ProfileImporterTest {

    private val app: TestNeroNetApplication =
        NeroNetApplication.from(ApplicationProvider.getApplicationContext<Context>()) as TestNeroNetApplication

    private val importer get() = ProfileImporter(app.profiles)

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private fun profileText(seed: Int): String =
        "# NeroNet-Profile: 1\n" +
            "[Interface]\nPrivateKey = ${fakeKey(seed)}\nAddress = 100.64.12.34/32\n" +
            "[Peer]\nPublicKey = ${fakeKey(seed + 100)}\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n"

    @Test
    fun importsAValidProfileAndSelectsIt() {
        val result = importer.importText(profileText(1))

        val imported = result as ImportResult.Imported
        assertEquals(listOf(imported.id), app.profiles.profiles.value.map { it.id })
        assertEquals(imported.id, app.profiles.selectedId.value)
    }

    @Test
    fun importingTheSameKeyTwiceReturnsDuplicate() {
        val first = (importer.importText(profileText(2)) as ImportResult.Imported).id
        val title = app.profiles.profiles.value.single().title

        val second = importer.importText(profileText(2))

        assertEquals(ImportResult.Duplicate(first, title), second)
        assertEquals(1, app.profiles.profiles.value.size)
        assertEquals(first, app.profiles.selectedId.value)
    }

    @Test
    fun oversizeTextIsTooLarge() {
        val text = "x".repeat(ProfileImporter.MAX_PROFILE_BYTES + 1)

        assertEquals(ImportResult.TooLarge, importer.importText(text))
    }

    @Test
    fun qrWithoutInterfaceIsNotAProfile() {
        assertEquals(ImportResult.NotAProfile, importer.importQr("https://example.com"))
    }

    @Test
    fun invalidProfileReturnsReason() {
        val refused = profileText(3).replace("[Interface]\n", "[Interface]\nPostUp = echo nope\n")

        val result = importer.importText(refused)

        assertEquals(ImportResult.Invalid(R.string.reason_refused_setting), result)
        assertTrue(app.profiles.profiles.value.isEmpty())
    }
}
