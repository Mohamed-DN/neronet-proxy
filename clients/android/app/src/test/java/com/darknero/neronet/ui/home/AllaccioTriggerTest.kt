package com.darknero.neronet.ui.home

import com.darknero.neronet.tunnel.TunnelError
import com.darknero.neronet.tunnel.TunnelPhase
import org.junit.Assert.assertEquals
import org.junit.Test

class AllaccioTriggerTest {
    private val connected = TunnelPhase.Connected("p", 0)

    @Test
    fun playsOnlyFromNotConnectedToConnected() {
        val notConnected = listOf(
            TunnelPhase.Disconnected,
            TunnelPhase.Connecting("p", 0),
            TunnelPhase.Disconnecting("p", 0),
            TunnelPhase.Error(TunnelError.TIMEOUT, "p"),
        )
        for (from in notConnected) assertEquals("from $from", true, AllaccioTrigger.shouldPlay(from, connected))
    }

    @Test
    fun staysQuietWhenAlreadyConnected() {
        assertEquals(false, AllaccioTrigger.shouldPlay(connected, connected))
    }

    @Test
    fun staysQuietWhenKillSwitchRestoresTheTunnel() {
        val held = TunnelPhase.Reconnecting("p", 0, attempt = 2, nextRetryMs = 0)
        assertEquals(false, AllaccioTrigger.shouldPlay(held, connected))
    }

    @Test
    fun neverPlaysForOtherTargets() {
        assertEquals(false, AllaccioTrigger.shouldPlay(TunnelPhase.Disconnected, TunnelPhase.Connecting("p", 0)))
        assertEquals(false, AllaccioTrigger.shouldPlay(connected, TunnelPhase.Disconnected))
    }

    @Test
    fun cancelsWhenTheTunnelLeavesConnected() {
        assertEquals(false, AllaccioTrigger.shouldCancel(connected))
        assertEquals(true, AllaccioTrigger.shouldCancel(TunnelPhase.Disconnecting("p", 0)))
    }
}
