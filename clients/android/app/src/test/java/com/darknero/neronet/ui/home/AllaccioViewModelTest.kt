package com.darknero.neronet.ui.home

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.NeroNetApplication
import com.darknero.neronet.TestNeroNetApplication
import com.darknero.neronet.tunnel.FakeClock
import com.darknero.neronet.tunnel.TunnelPhase
import com.darknero.neronet.tunnel.TunnelRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.Base64

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class AllaccioViewModelTest {
    private val app: TestNeroNetApplication =
        NeroNetApplication.from(ApplicationProvider.getApplicationContext<Context>()) as TestNeroNetApplication

    @After
    fun restoreMain() = Dispatchers.resetMain()

    private fun key(seed: Int) = Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private fun profileText() =
        "# NeroNet-Profile: 1\n[Interface]\nPrivateKey = ${key(1)}\nAddress = 100.64.12.34/32\n" +
            "[Peer]\nPublicKey = ${key(101)}\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n"

    @Test
    fun playsOnConnectThenClearsWhenDone() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val clock = FakeClock(testScheduler)
        val repo = TunnelRepository(app.fakeEngine, { app.profiles.profile(it) }, clock, backgroundScope)
        app.profiles.add(profileText())
        val vm = HomeViewModel(repo, app.profiles, clock)
        runCurrent()
        assertFalse(vm.allaccio.value)

        vm.onToggle(true)
        advanceTimeBy(100)
        runCurrent()
        assertTrue(repo.state.value.phase is TunnelPhase.Connected)
        assertTrue(vm.allaccio.value)

        vm.onAllaccioDone()
        assertFalse(vm.allaccio.value)
    }

    @Test
    fun staysQuietWhenTheAppOpensAlreadyConnected() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val clock = FakeClock(testScheduler)
        val repo = TunnelRepository(app.fakeEngine, { app.profiles.profile(it) }, clock, backgroundScope)
        app.profiles.add(profileText())
        HomeViewModel(repo, app.profiles, clock).onToggle(true)
        advanceTimeBy(100)
        runCurrent()
        assertTrue(repo.state.value.phase is TunnelPhase.Connected)

        // A second view model (the process was recreated) starts from Connected: nothing to play.
        val reopened = HomeViewModel(repo, app.profiles, clock)
        runCurrent()
        assertFalse(reopened.allaccio.value)
    }

    @Test
    fun dropsAPendingAnimationWhenTheTunnelGoesDown() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        val clock = FakeClock(testScheduler)
        val repo = TunnelRepository(app.fakeEngine, { app.profiles.profile(it) }, clock, backgroundScope)
        app.profiles.add(profileText())
        val vm = HomeViewModel(repo, app.profiles, clock)
        runCurrent()
        vm.onToggle(true)
        advanceTimeBy(100)
        runCurrent()
        assertTrue(vm.allaccio.value)

        vm.onToggle(false)
        advanceTimeBy(100)
        runCurrent()
        assertFalse(vm.allaccio.value)
    }
}
