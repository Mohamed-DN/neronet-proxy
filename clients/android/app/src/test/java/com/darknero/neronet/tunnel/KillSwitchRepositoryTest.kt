package com.darknero.neronet.tunnel

import com.darknero.neronet.NeroNetProfile
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import com.wireguard.config.InetNetwork
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** The kill switch through the repository: what the engine is asked to do, and in which order. */
@OptIn(ExperimentalCoroutinesApi::class)
class KillSwitchRepositoryTest {

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private val profile = NeroNetProfile.parse(
        "# NeroNet-Profile: 1\n" +
            "[Interface]\nPrivateKey = ${fakeKey(1)}\nAddress = 100.64.12.34/32\n" +
            "[Peer]\nPublicKey = ${fakeKey(50)}\nEndpoint = gateway.example:51820\nAllowedIPs = 0.0.0.0/0\n",
    )

    private fun repository(scope: TestScope, engine: FakeTunnelEngine, killSwitch: Boolean = true) =
        TunnelRepository(
            engine,
            { if (it == "p1") profile else null },
            FakeClock(scope.testScheduler),
            scope.backgroundScope,
            killSwitchFor = { killSwitch },
        )

    private fun phase(repo: TunnelRepository): TunnelPhase = repo.state.value.phase

    private fun TestScope.advance(ms: Long) {
        advanceTimeBy(ms)
        runCurrent()
    }

    private fun TestScope.connected(engine: FakeTunnelEngine, killSwitch: Boolean = true): TunnelRepository {
        val repo = repository(this, engine, killSwitch)
        repo.connect("p1")
        advance(10)
        assertTrue(phase(repo) is TunnelPhase.Connected)
        return repo
    }

    @Test
    fun dropBringsUpTheBlockingInterfaceAndWaits() = runTest {
        val engine = FakeTunnelEngine()
        val repo = connected(engine)

        engine.emit("p1", false)
        advance(10)

        assertTrue(phase(repo) is TunnelPhase.Reconnecting)
        assertEquals(listOf("p1"), engine.blocks)
        assertEquals(
            TunnelConfigs.BLOCK_ROUTES.map { InetNetwork.parse(it).toString() },
            TunnelConfigs.routesOf(engine.blockConfigs.single()),
        )
        assertTrue(engine.blockConfigs.single().peers.single().endpoint.isEmpty)
        assertTrue(repo.state.value.wantConnected)
    }

    @Test
    fun dropWithKillSwitchOffGoesToError() = runTest {
        val engine = FakeTunnelEngine()
        val repo = connected(engine, killSwitch = false)

        engine.emit("p1", false)
        advance(10)

        assertEquals(TunnelPhase.Error(TunnelError.VPN_REVOKED, "p1"), phase(repo))
        assertTrue(engine.blocks.isEmpty())
    }

    @Test
    fun retryRestoresTheTunnelAfterTheFirstDelay() = runTest {
        val engine = FakeTunnelEngine()
        val repo = connected(engine)
        engine.emit("p1", false)
        advance(10)
        assertEquals(1, engine.ups.size)

        advance(TunnelTimings.RECONNECT_FIRST_MS)

        assertTrue(phase(repo) is TunnelPhase.Connected)
        assertEquals(2, engine.ups.size)
        // The retry brings up the real profile: its own routes, not the block.
        assertEquals(listOf("0.0.0.0/0"), TunnelConfigs.routesOf(engine.upConfigs.last()))
    }

    @Test
    fun failedRetriesKeepTheBlockUntilOneSucceeds() = runTest {
        val engine = FakeTunnelEngine()
        val repo = connected(engine)
        engine.emit("p1", false)
        advance(10)
        engine.upFailures = 2

        advance(TunnelTimings.RECONNECT_FIRST_MS + 500)
        assertTrue(phase(repo) is TunnelPhase.Reconnecting)
        advance(6_000)
        assertTrue(phase(repo) is TunnelPhase.Reconnecting)
        advance(14_000)

        assertTrue(phase(repo) is TunnelPhase.Connected)
        assertEquals(1, engine.blocks.size)
    }

    @Test
    fun turningTheTunnelOffEndsTheBlock() = runTest {
        val engine = FakeTunnelEngine()
        val repo = connected(engine)
        engine.emit("p1", false)
        advance(10)

        repo.disconnect()
        advance(10)

        assertEquals(TunnelPhase.Disconnected, phase(repo))
        assertEquals(listOf("p1"), engine.downs)
        assertEquals(false, repo.state.value.wantConnected)
    }

    @Test
    fun blockThatCannotStartIsAnError() = runTest {
        val engine = FakeTunnelEngine()
        val repo = connected(engine)
        engine.blockFailure = IllegalStateException("not authorised")

        engine.emit("p1", false)
        advance(10)

        assertEquals(TunnelPhase.Error(TunnelError.VPN_REVOKED, "p1"), phase(repo))
        assertEquals(false, repo.state.value.wantConnected)
    }
}
