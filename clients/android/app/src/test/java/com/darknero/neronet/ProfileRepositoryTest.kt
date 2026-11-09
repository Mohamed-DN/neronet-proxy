package com.darknero.neronet

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import java.util.Base64

@RunWith(AndroidJUnit4::class)
class ProfileRepositoryTest {

    @get:Rule
    val folder = TemporaryFolder()

    private val context: Context = ApplicationProvider.getApplicationContext()

    private lateinit var settings: SettingsStore
    private lateinit var repo: ProfileRepository

    @Before
    fun setUp() {
        context.getSharedPreferences("neronet_settings", Context.MODE_PRIVATE).edit().clear().commit()
        settings = SettingsStore(context.getSharedPreferences("neronet_settings", Context.MODE_PRIVATE))
        repo = ProfileRepository(ProfileStore(folder.newFolder("profiles")), settings)
    }

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private fun profileText(seed: Int): String =
        "# NeroNet-Profile: 1\n" +
            "[Interface]\nPrivateKey = ${fakeKey(seed)}\nAddress = 100.64.12.34/32\n" +
            "[Peer]\nPublicKey = ${fakeKey(seed + 100)}\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n"

    @Test
    fun selectedFallsBackToFirstProfile() {
        repo.add(profileText(1))
        repo.add(profileText(2))

        assertEquals(repo.profiles.value.first().id, repo.selectedId.value)
    }

    @Test
    fun selectWritesLastProfileId() {
        repo.add(profileText(1))
        val second = repo.add(profileText(2))

        repo.select(second)

        assertEquals(second, settings.lastProfileId)
        assertEquals(second, repo.selectedId.value)
    }

    @Test
    fun deleteClearsLastProfileIdOfThatProfile() {
        val first = repo.add(profileText(1))
        val second = repo.add(profileText(2))
        repo.select(first)

        repo.delete(first)

        assertNull(settings.lastProfileId)
        assertEquals(listOf(second), repo.profiles.value.map { it.id })
        assertEquals(second, repo.selectedId.value)
    }

    @Test
    fun addRefreshesTheList() {
        assertTrue(repo.profiles.value.isEmpty())

        val id = repo.add(profileText(1))

        assertEquals(listOf(id), repo.profiles.value.map { it.id })
    }

    @Test
    fun applicationUsesTheFakeEngine() {
        val app = NeroNetApplication.from(ApplicationProvider.getApplicationContext())
        val fake = (app as TestNeroNetApplication).fakeEngine
        val id = app.profiles.add(profileText(7))

        app.tunnels.connect(id)

        val deadline = System.currentTimeMillis() + 5_000
        while (fake.ups.isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertEquals(listOf(id), fake.ups)
    }
}
