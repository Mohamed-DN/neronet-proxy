package com.darknero.neronet.tunnel

import com.darknero.neronet.NeroNetProfile
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** The per-app lists reach the engine on connect, on the kill switch's block and on its retries. */
@OptIn(ExperimentalCoroutinesApi::class)
class SplitTunnelRepositoryTest {

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private val profile = NeroNetProfile.parse(
        "# NeroNet-Profile: 1\n" +
            "[Interface]\nPrivateKey = ${fakeKey(1)}\nAddress = 100.64.12.34/32\n" +
            "[Peer]\nPublicKey = ${fakeKey(50)}\nEndpoint = gateway.example:51820\nAllowedIPs = 0.0.0.0/0\n",
    )

    private val rules = AppRules(AppRuleMode.EXCLUDE, setOf("org.example.bank"))

    private fun repository(scope: TestScope, engine: FakeTunnelEngine) = TunnelRepository(
        engine,
        { if (it == "p1") profile else null },
        FakeClock(scope.testScheduler),
        scope.backgroundScope,
        killSwitchFor = { true },
        configFor = { _, p -> TunnelConfigs.withAppRules(p.config, rules) },
    )

    private fun TestScope.advance(ms: Long) {
        advanceTimeBy(ms)
        runCurrent()
    }

    @Test
    fun connectBringsUpTheConfigWithTheList() = runTest {
        val engine = FakeTunnelEngine()
        val repo = repository(this, engine)

        repo.connect("p1")
        advance(10)

        assertEquals(setOf("org.example.bank"), engine.upConfigs.single().`interface`.excludedApplications)
    }

    @Test
    fun blockAndRetryKeepTheList() = runTest {
        val engine = FakeTunnelEngine()
        val repo = repository(this, engine)
        repo.connect("p1")
        advance(10)

        engine.emit("p1", false)
        advance(10)
        assertEquals(setOf("org.example.bank"), engine.blockConfigs.single().`interface`.excludedApplications)

        advance(TunnelTimings.RECONNECT_FIRST_MS)
        assertTrue(repo.state.value.phase is TunnelPhase.Connected)
        assertEquals(setOf("org.example.bank"), engine.upConfigs.last().`interface`.excludedApplications)
    }
}
