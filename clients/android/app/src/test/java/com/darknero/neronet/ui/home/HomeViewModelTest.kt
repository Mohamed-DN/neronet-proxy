package com.darknero.neronet.ui.home

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.NeroNetApplication
import com.darknero.neronet.R
import com.darknero.neronet.TestNeroNetApplication
import com.darknero.neronet.tunnel.FakeClock
import com.darknero.neronet.tunnel.TunnelPhase
import com.darknero.neronet.tunnel.TunnelRepository
import com.darknero.neronet.tunnel.TunnelStats
import com.darknero.neronet.ui.UiText
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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Base64

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class HomeViewModelTest {

    private val app: TestNeroNetApplication =
        NeroNetApplication.from(ApplicationProvider.getApplicationContext<Context>()) as TestNeroNetApplication

    @After
    fun restoreMain() {
        Dispatchers.resetMain()
    }

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private val peerKey = fakeKey(101)

    private fun profileText(): String =
        "# NeroNet-Profile: 1\n" +
            "[Interface]\nPrivateKey = ${fakeKey(1)}\nAddress = 100.64.12.34/32\n" +
            "[Peer]\nPublicKey = $peerKey\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n"

    @Test
    fun toggleOnConnectsSelectedProfile() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val clock = FakeClock(testScheduler)
        val repo = TunnelRepository(app.fakeEngine, { app.profiles.profile(it) }, clock, backgroundScope)
        val id = app.profiles.add(profileText())
        val vm = HomeViewModel(repo, app.profiles, clock)
        backgroundScope.launch { vm.uiState.collect { } }

        vm.onToggle(true)
        advanceTimeBy(100)
        runCurrent()
        assertEquals(listOf(id), app.fakeEngine.ups)

        app.fakeEngine.statsResult = TunnelStats(0, 0, mapOf(peerKey to clock.wallMs()))
        advanceTimeBy(2_000)
        runCurrent()

        assertEquals(R.string.status_protected_title, (vm.uiState.value.title as UiText.Res).id)
    }

    @Test
    fun toggleOffWhileConnectedDisconnects() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val clock = FakeClock(testScheduler)
        val repo = TunnelRepository(app.fakeEngine, { app.profiles.profile(it) }, clock, backgroundScope)
        val id = app.profiles.add(profileText())
        val vm = HomeViewModel(repo, app.profiles, clock)
        backgroundScope.launch { vm.uiState.collect { } }

        vm.onToggle(true)
        advanceTimeBy(100)
        runCurrent()
        assertTrue(repo.state.value.phase is TunnelPhase.Connected)

        vm.onToggle(false)
        advanceTimeBy(100)
        runCurrent()

        assertEquals(listOf(id), app.fakeEngine.downs)
        assertEquals(TunnelPhase.Disconnected, repo.state.value.phase)
    }
}
