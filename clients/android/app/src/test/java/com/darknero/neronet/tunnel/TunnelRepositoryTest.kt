package com.darknero.neronet.tunnel

import com.darknero.neronet.NeroNetProfile
import com.wireguard.android.backend.BackendException
import com.wireguard.android.backend.BackendException.Reason
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

@OptIn(ExperimentalCoroutinesApi::class)
class TunnelRepositoryTest {

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private val profile = NeroNetProfile.parse(
        "# NeroNet-Profile: 1\n" +
            "[Interface]\nPrivateKey = ${fakeKey(1)}\nAddress = 100.64.12.34/32\n" +
            "[Peer]\nPublicKey = ${fakeKey(50)}\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n",
    )

    private fun repository(
        scope: TestScope,
        engine: FakeTunnelEngine,
        lookup: (String) -> NeroNetProfile? = { if (it == "p1") profile else null },
    ) = TunnelRepository(engine, lookup, FakeClock(scope.testScheduler), scope.backgroundScope)

    private fun phase(repo: TunnelRepository): TunnelPhase = repo.state.value.phase

    /**
     * Runs everything queued, including the repository's backgroundScope work: settle() leaves
     * background coroutines alone, so the effect consumer never ran under it. Advancing virtual time does.
     */
    private fun TestScope.settle() {
        advanceTimeBy(60_000)
        runCurrent()
    }

    @Test
    fun connectReachesConnected() = runTest {
        val engine = FakeTunnelEngine()
        val repo = repository(this, engine)

        repo.connect("p1")
        settle()

        val connected = phase(repo) as TunnelPhase.Connected
        assertEquals("p1", connected.profileId)
        assertEquals(listOf("p1"), engine.ups)
    }

    @Test
    fun slowUpTimesOutThenStops() = runTest {
        val engine = FakeTunnelEngine()
        engine.upDelayMs = 8_000
        val repo = repository(this, engine)

        repo.connect("p1")
        advanceTimeBy(7_250)
        runCurrent()
        assertEquals(TunnelPhase.Error(TunnelError.TIMEOUT, "p1"), phase(repo))

        settle()
        assertEquals(listOf("p1"), engine.downs)
        assertEquals(TunnelPhase.Error(TunnelError.TIMEOUT, "p1"), phase(repo))
    }

    @Test
    fun cancelHonouredOnlyAfterTwoSeconds() = runTest {
        val engine = FakeTunnelEngine()
        engine.upDelayMs = 5_000
        val repo = repository(this, engine)

        repo.connect("p1")
        advanceTimeBy(1_500)
        runCurrent()
        repo.cancel()
        runCurrent()
        assertTrue(phase(repo) is TunnelPhase.Connecting)

        advanceTimeBy(500)
        runCurrent()
        repo.cancel()
        runCurrent()
        assertTrue(phase(repo) is TunnelPhase.Disconnecting)

        settle()
        assertEquals(TunnelPhase.Disconnected, phase(repo))
    }

    @Test
    fun backendFailureBecomesItsError() = runTest {
        val engine = FakeTunnelEngine()
        engine.upFailure = BackendException(Reason.DNS_RESOLUTION_FAILURE)
        val repo = repository(this, engine)

        repo.connect("p1")
        settle()

        assertEquals(TunnelPhase.Error(TunnelError.DNS_RESOLUTION_FAILURE, "p1"), phase(repo))
    }

    @Test
    fun listenerDownWhileConnectedBecomesRevoked() = runTest {
        val engine = FakeTunnelEngine()
        val repo = repository(this, engine)
        repo.connect("p1")
        settle()

        engine.emit("p1", false)
        runCurrent()

        assertEquals(TunnelPhase.Error(TunnelError.VPN_REVOKED, "p1"), phase(repo))
        assertEquals(false, repo.state.value.wantConnected)
    }

    @Test
    fun missingProfileIsProfileMissing() = runTest {
        val engine = FakeTunnelEngine()
        val repo = repository(this, engine, lookup = { null })

        repo.connect("p1")
        settle()

        assertEquals(TunnelPhase.Error(TunnelError.PROFILE_MISSING, "p1"), phase(repo))
        assertTrue(engine.ups.isEmpty())
    }

    @Test
    fun statsOnlyWhileConnected() = runTest {
        val engine = FakeTunnelEngine()
        val expected = TunnelStats(rxBytes = 10L, txBytes = 20L, lastHandshakeWallMs = mapOf("k" to 1_700_000_000_000L))
        engine.statsResult = expected
        val repo = repository(this, engine)

        assertNull(repo.stats())

        repo.connect("p1")
        settle()
        assertEquals(expected, repo.stats())
    }
}
