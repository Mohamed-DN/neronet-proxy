package com.darknero.neronet.tunnel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The kill switch rows of the transition table (ADR 0035). */
class KillSwitchStateMachineTest {

    private val a = "profile-a"
    private val b = "profile-b"

    private fun reduce(state: MachineState, event: TunnelEvent) = TunnelStateMachine.reduce(state, event)

    private val connected = MachineState(TunnelPhase.Connected(a, 500), wantConnected = true)

    private fun reconnecting(attempt: Int = 0, nextRetryMs: Long = 4_000, retrying: Boolean = false) =
        MachineState(TunnelPhase.Reconnecting(a, 1_000, attempt, nextRetryMs, retrying), wantConnected = true)

    @Test
    fun unexpectedDropWithKillSwitchHoldsTrafficAndKeepsTheWish() {
        val t = reduce(connected, TunnelEvent.BackendDown(a, 1_000, killSwitch = true))
        assertEquals(reconnecting(), t.state)
        assertEquals(TunnelEffect.BlockTraffic(a), t.effect)
    }

    @Test
    fun unexpectedDropWithoutKillSwitchStaysRevoked() {
        val t = reduce(connected, TunnelEvent.BackendDown(a, 1_000, killSwitch = false))
        assertEquals(MachineState(TunnelPhase.Error(TunnelError.VPN_REVOKED, a), false), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun dropAfterTheUserDisconnectedDoesNotBlock() {
        val disconnecting = MachineState(TunnelPhase.Disconnecting(a, 900), wantConnected = false)
        val t = reduce(disconnecting, TunnelEvent.BackendDown(a, 1_000, killSwitch = true))
        assertEquals(MachineState(TunnelPhase.Disconnected, false), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun backendEventsDuringTheBlockAreIgnored() {
        val state = reconnecting()
        assertEquals(state, reduce(state, TunnelEvent.BackendUp(a, 1_100)).state)
        val down = reduce(state, TunnelEvent.BackendDown(a, 1_100, killSwitch = true))
        assertEquals(state, down.state)
        assertEquals(TunnelEffect.None, down.effect)
    }

    @Test
    fun tickBeforeTheRetryTimeDoesNothing() {
        val t = reduce(reconnecting(nextRetryMs = 4_000), TunnelEvent.Tick(3_999))
        assertEquals(reconnecting(nextRetryMs = 4_000), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun tickAtTheRetryTimeStartsOneRetry() {
        val t = reduce(reconnecting(nextRetryMs = 4_000), TunnelEvent.Tick(4_000))
        assertEquals(reconnecting(nextRetryMs = 4_000, retrying = true), t.state)
        assertEquals(TunnelEffect.RetryTunnel(a), t.effect)
    }

    @Test
    fun noSecondRetryWhileOneRuns() {
        val running = reconnecting(nextRetryMs = 4_000, retrying = true)
        val t = reduce(running, TunnelEvent.Tick(9_000))
        assertEquals(running, t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun failedRetryBacksOff() {
        val t = reduce(reconnecting(retrying = true), TunnelEvent.RetryFailed(a, 5_000))
        assertEquals(reconnecting(attempt = 1, nextRetryMs = 5_000 + 6_000), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun backoffDoublesThenStopsAtThirtySeconds() {
        val delays = (0..6).map { TunnelTimings.reconnectDelayMs(it) }
        assertEquals(listOf(3_000L, 6_000L, 12_000L, 24_000L, 30_000L, 30_000L, 30_000L), delays)
    }

    @Test
    fun restoredTunnelIsConnectedAgain() {
        val t = reduce(reconnecting(retrying = true), TunnelEvent.TunnelRestored(a, 7_000))
        assertEquals(MachineState(TunnelPhase.Connected(a, 7_000), true), t.state)
    }

    @Test
    fun blockFailureLeavesTheErrorAndTheWishOff() {
        val t = reduce(reconnecting(), TunnelEvent.BlockFailed(a))
        assertEquals(MachineState(TunnelPhase.Error(TunnelError.VPN_REVOKED, a), false), t.state)
    }

    @Test
    fun userDisconnectIsTheWayOutOfTheBlock() {
        val t = reduce(reconnecting(), TunnelEvent.UserDisconnect(2_000))
        assertEquals(MachineState(TunnelPhase.Disconnecting(a, 2_000), false), t.state)
        assertEquals(TunnelEffect.StopTunnel(a), t.effect)
    }

    @Test
    fun cancelAlsoLeavesTheBlockWithoutWaiting() {
        val t = reduce(reconnecting(), TunnelEvent.UserCancel(1_001))
        assertEquals(TunnelEffect.StopTunnel(a), t.effect)
    }

    @Test
    fun connectingAnotherProfileLeavesTheBlock() {
        val t = reduce(reconnecting(), TunnelEvent.UserConnect(b, 2_000))
        assertEquals(MachineState(TunnelPhase.Connecting(b, 2_000), true), t.state)
        assertEquals(TunnelEffect.StartTunnel(b), t.effect)
    }

    @Test
    fun connectingTheSameProfileDuringTheBlockDoesNothing() {
        val t = reduce(reconnecting(), TunnelEvent.UserConnect(a, 2_000))
        assertEquals(reconnecting(), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun lateEventsOfAnotherPhaseAreIgnored() {
        val idle = MachineState()
        assertEquals(idle, reduce(idle, TunnelEvent.TunnelRestored(a, 1)).state)
        assertEquals(idle, reduce(idle, TunnelEvent.RetryFailed(a, 1)).state)
        assertEquals(idle, reduce(idle, TunnelEvent.BlockFailed(a)).state)
    }

    @Test
    fun reconnectingNeedsTicksButIsNotPending() {
        val phase = TunnelPhase.Reconnecting(a, 0, 0, 3_000)
        assertTrue(TunnelStateMachine.needsTicks(phase))
        assertFalse(TunnelStateMachine.isPending(phase))
    }
}
