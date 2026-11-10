package com.darknero.neronet.ui.profiles

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.NeroNetApplication
import com.darknero.neronet.ProfileImporter
import com.darknero.neronet.TestNeroNetApplication
import com.darknero.neronet.tunnel.FakeClock
import com.darknero.neronet.tunnel.TunnelPhase
import com.darknero.neronet.tunnel.TunnelRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Base64

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class ProfilesViewModelTest {

    private val app: TestNeroNetApplication =
        NeroNetApplication.from(ApplicationProvider.getApplicationContext<Context>()) as TestNeroNetApplication

    @After
    fun restoreMain() {
        Dispatchers.resetMain()
    }

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private fun profileText(seed: Int): String =
        "# NeroNet-Profile: 1\n" +
            "[Interface]\nPrivateKey = ${fakeKey(seed)}\nAddress = 100.64.12.34/32\n" +
            "[Peer]\nPublicKey = ${fakeKey(seed + 100)}\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n"

    @Test
    fun deletingTheActiveProfileDisconnectsFirst() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val clock = FakeClock(testScheduler)
        val repo = TunnelRepository(app.fakeEngine, { app.profiles.profile(it) }, clock, backgroundScope)
        val first = app.profiles.add(profileText(10))
        val second = app.profiles.add(profileText(20))
        app.profiles.select(first)
        val vm = ProfilesViewModel(app.profiles, repo, ProfileImporter(app.profiles))
        backgroundScope.launch { vm.profiles.collect { } }

        repo.connect(first)
        advanceTimeBy(100)
        runCurrent()
        assertEquals(listOf(first), app.fakeEngine.ups)

        vm.delete(first)
        advanceTimeBy(100)
        runCurrent()

        assertEquals(listOf(first), app.fakeEngine.downs)
        assertEquals(listOf(second), app.profiles.profiles.value.map { it.id })
        assertEquals(second, app.profiles.selectedId.value)
        assertFalse(app.settings.lastProfileId == first)
        assertNull(app.profiles.profile(first))
    }

    @Test
    fun selectingAnotherProfileWhileConnectedReconnects() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val clock = FakeClock(testScheduler)
        val repo = TunnelRepository(app.fakeEngine, { app.profiles.profile(it) }, clock, backgroundScope)
        val first = app.profiles.add(profileText(30))
        val second = app.profiles.add(profileText(40))
        app.profiles.select(first)
        val vm = ProfilesViewModel(app.profiles, repo, ProfileImporter(app.profiles))
        backgroundScope.launch { vm.profiles.collect { } }

        repo.connect(first)
        advanceTimeBy(100)
        runCurrent()
        assertTrue(repo.state.value.phase is TunnelPhase.Connected)

        vm.select(second)
        advanceTimeBy(100)
        runCurrent()

        assertEquals(listOf(first, second), app.fakeEngine.ups)
        assertEquals(second, app.profiles.selectedId.value)
    }
}
