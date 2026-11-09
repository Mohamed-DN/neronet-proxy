package com.darknero.neronet.tunnel

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** One test per row of the transition table in the plan (Task 5), named after the row. */
class TunnelStateMachineTest {

    private val a = "profile-a"
    private val b = "profile-b"

    private fun reduce(state: MachineState, event: TunnelEvent) = TunnelStateMachine.reduce(state, event)

    private fun machine(phase: TunnelPhase, wantConnected: Boolean = false) = MachineState(phase, wantConnected)

    private val disconnected = machine(TunnelPhase.Disconnected)

    // Disconnected or Error: UserConnect

    @Test
    fun connectFromDisconnectedStartsTheTunnel() {
        val t = reduce(disconnected, TunnelEvent.UserConnect(a, 1_000))
        assertEquals(machine(TunnelPhase.Connecting(a, 1_000), wantConnected = true), t.state)
        assertEquals(TunnelEffect.StartTunnel(a), t.effect)
    }

    @Test
    fun connectFromErrorStartsTheTunnel() {
        val error = machine(TunnelPhase.Error(TunnelError.TIMEOUT, a))
        val t = reduce(error, TunnelEvent.UserConnect(b, 2_000))
        assertEquals(machine(TunnelPhase.Connecting(b, 2_000), wantConnected = true), t.state)
        assertEquals(TunnelEffect.StartTunnel(b), t.effect)
    }

    // Connected(a): UserConnect

    @Test
    fun switchingProfilesStartsTheNewTunnel() {
        val connected = machine(TunnelPhase.Connected(a, 500), wantConnected = true)
        val t = reduce(connected, TunnelEvent.UserConnect(b, 3_000))
        assertEquals(machine(TunnelPhase.Connecting(b, 3_000), wantConnected = true), t.state)
        assertEquals(TunnelEffect.StartTunnel(b), t.effect)
    }

    @Test
    fun connectToTheConnectedProfileDoesNothing() {
        val connected = machine(TunnelPhase.Connected(a, 500), wantConnected = true)
        val t = reduce(connected, TunnelEvent.UserConnect(a, 3_000))
        assertEquals(connected, t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    // Connecting or Disconnecting: UserConnect

    @Test
    fun connectWhileConnectingDoesNothing() {
        val connecting = machine(TunnelPhase.Connecting(a, 0), wantConnected = true)
        val t = reduce(connecting, TunnelEvent.UserConnect(b, 100))
        assertEquals(connecting, t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun connectWhileDisconnectingDoesNothing() {
        val disconnecting = machine(TunnelPhase.Disconnecting(a, 0))
        val t = reduce(disconnecting, TunnelEvent.UserConnect(b, 100))
        assertEquals(disconnecting, t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    // Connecting(id, s): BackendUp, BackendDown, BackendFailed

    @Test
    fun connectingBecomesConnectedWhenTheBackendIsUp() {
        val connecting = machine(TunnelPhase.Connecting(a, 1_000), wantConnected = true)
        val t = reduce(connecting, TunnelEvent.BackendUp(a, 4_000))
        assertEquals(machine(TunnelPhase.Connected(a, 4_000), wantConnected = true), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun unrelatedBackendEventsWhileConnectingAreIgnored() {
        val connecting = machine(TunnelPhase.Connecting(a, 1_000), wantConnected = true)
        assertEquals(connecting, reduce(connecting, TunnelEvent.BackendUp(b, 4_000)).state)
        assertEquals(connecting, reduce(connecting, TunnelEvent.BackendDown(a, 4_000)).state)
        assertEquals(connecting, reduce(connecting, TunnelEvent.BackendDown(b, 4_000)).state)
    }

    @Test
    fun backendFailureWhileConnectingBecomesAnError() {
        val connecting = machine(TunnelPhase.Connecting(a, 1_000), wantConnected = true)
        val t = reduce(connecting, TunnelEvent.BackendFailed(a, TunnelError.GO_ACTIVATION_ERROR))
        assertEquals(machine(TunnelPhase.Error(TunnelError.GO_ACTIVATION_ERROR, a)), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    // Connecting(id, s), elapsed below or at 2 s: UserCancel, UserDisconnect

    @Test
    fun cancelBeforeTwoSecondsIsIgnored() {
        val connecting = machine(TunnelPhase.Connecting(a, 1_000), wantConnected = true)
        val t = reduce(connecting, TunnelEvent.UserCancel(2_999))
        assertEquals(connecting, t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun disconnectBeforeTwoSecondsIsIgnored() {
        val connecting = machine(TunnelPhase.Connecting(a, 1_000), wantConnected = true)
        val t = reduce(connecting, TunnelEvent.UserDisconnect(2_999))
        assertEquals(connecting, t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    // Connecting(id, s), elapsed at least 2 s: UserCancel, UserDisconnect

    @Test
    fun cancelAtTwoSecondsStopsTheTunnel() {
        val connecting = machine(TunnelPhase.Connecting(a, 1_000), wantConnected = true)
        val t = reduce(connecting, TunnelEvent.UserCancel(3_000))
        assertEquals(machine(TunnelPhase.Disconnecting(a, 3_000)), t.state)
        assertEquals(TunnelEffect.StopTunnel(a), t.effect)
    }

    @Test
    fun disconnectAfterTwoSecondsStopsTheTunnel() {
        val connecting = machine(TunnelPhase.Connecting(a, 1_000), wantConnected = true)
        val t = reduce(connecting, TunnelEvent.UserDisconnect(3_500))
        assertEquals(machine(TunnelPhase.Disconnecting(a, 3_500)), t.state)
        assertEquals(TunnelEffect.StopTunnel(a), t.effect)
    }

    // Connecting(id, s), elapsed at least 7 s: Tick

    @Test
    fun tickBeforeSevenSecondsDoesNothing() {
        val connecting = machine(TunnelPhase.Connecting(a, 1_000), wantConnected = true)
        val t = reduce(connecting, TunnelEvent.Tick(7_999))
        assertEquals(connecting, t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun tickAtSevenSecondsTimesOut() {
        val connecting = machine(TunnelPhase.Connecting(a, 1_000), wantConnected = true)
        val t = reduce(connecting, TunnelEvent.Tick(8_000))
        assertEquals(machine(TunnelPhase.Error(TunnelError.TIMEOUT, a)), t.state)
        assertEquals(TunnelEffect.StopTunnel(a), t.effect)
    }

    // Connected(id)

    @Test
    fun disconnectFromConnectedStopsTheTunnel() {
        val connected = machine(TunnelPhase.Connected(a, 500), wantConnected = true)
        val t = reduce(connected, TunnelEvent.UserDisconnect(9_000))
        assertEquals(machine(TunnelPhase.Disconnecting(a, 9_000)), t.state)
        assertEquals(TunnelEffect.StopTunnel(a), t.effect)
    }

    @Test
    fun unrequestedDownWhileConnectedIsARevoke() {
        val connected = machine(TunnelPhase.Connected(a, 500), wantConnected = true)
        val t = reduce(connected, TunnelEvent.BackendDown(a, 9_000))
        assertEquals(machine(TunnelPhase.Error(TunnelError.VPN_REVOKED, a)), t.state)
        assertFalse(t.state.wantConnected)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun connectedIgnoresARepeatedUp() {
        val connected = machine(TunnelPhase.Connected(a, 500), wantConnected = true)
        val t = reduce(connected, TunnelEvent.BackendUp(a, 9_000))
        assertEquals(connected, t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    // Disconnecting(id)

    @Test
    fun downWhileDisconnectingCompletesTheDisconnect() {
        val disconnecting = machine(TunnelPhase.Disconnecting(a, 1_000))
        val t = reduce(disconnecting, TunnelEvent.BackendDown(a, 1_500))
        assertEquals(machine(TunnelPhase.Disconnected), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun failureWhileDisconnectingBecomesAnError() {
        val disconnecting = machine(TunnelPhase.Disconnecting(a, 1_000))
        val t = reduce(disconnecting, TunnelEvent.BackendFailed(a, TunnelError.UNKNOWN))
        assertEquals(machine(TunnelPhase.Error(TunnelError.UNKNOWN, a)), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun disconnectingForSevenSecondsTimesOut() {
        val disconnecting = machine(TunnelPhase.Disconnecting(a, 1_000))
        val t = reduce(disconnecting, TunnelEvent.Tick(8_000))
        assertEquals(machine(TunnelPhase.Error(TunnelError.DISCONNECT_TIMEOUT, a)), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun downAfterDisconnectTimeoutCompletesTheDisconnect() {
        val timedOut = machine(TunnelPhase.Error(TunnelError.DISCONNECT_TIMEOUT, a))
        val t = reduce(timedOut, TunnelEvent.BackendDown(a, 9_000))
        assertEquals(machine(TunnelPhase.Disconnected), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun lateUpAfterTimeoutKeepsTheTimeoutError() {
        val timedOut = machine(TunnelPhase.Error(TunnelError.TIMEOUT, a))
        assertEquals(timedOut, reduce(timedOut, TunnelEvent.BackendUp(a, 9_000)).state)
    }

    @Test
    fun lateFailureAfterTimeoutKeepsTheTimeoutError() {
        val timedOut = machine(TunnelPhase.Error(TunnelError.TIMEOUT, a))
        assertEquals(timedOut, reduce(timedOut, TunnelEvent.BackendFailed(a, TunnelError.UNKNOWN)).state)
    }

    @Test
    fun dismissingAnErrorReturnsToDisconnected() {
        val error = machine(TunnelPhase.Error(TunnelError.UNKNOWN, a))
        val t = reduce(error, TunnelEvent.UserDismissError)
        assertEquals(machine(TunnelPhase.Disconnected), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    // Disconnected: BackendUp, always-on, permission

    @Test
    fun aRunningTunnelIsAdoptedWhenDisconnected() {
        val t = reduce(disconnected, TunnelEvent.BackendUp(a, 4_000))
        assertEquals(machine(TunnelPhase.Connected(a, 4_000), wantConnected = true), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun permissionDeniedBecomesAnError() {
        val t = reduce(disconnected, TunnelEvent.PermissionDenied(a))
        assertEquals(machine(TunnelPhase.Error(TunnelError.VPN_PERMISSION_DENIED, a)), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    @Test
    fun alwaysOnStartsTheLastProfile() {
        val t = reduce(disconnected, TunnelEvent.AlwaysOnStarted(a, 5_000))
        assertEquals(machine(TunnelPhase.Connecting(a, 5_000), wantConnected = true), t.state)
        assertEquals(TunnelEffect.StartTunnel(a), t.effect)
    }

    @Test
    fun alwaysOnWithoutProfileIsProfileMissing() {
        val t = reduce(disconnected, TunnelEvent.AlwaysOnStarted(null, 5_000))
        assertEquals(machine(TunnelPhase.Error(TunnelError.PROFILE_MISSING, null)), t.state)
        assertEquals(TunnelEffect.None, t.effect)
    }

    // Cancel window and pending phases

    @Test
    fun canCancelIsFalseAtOneSecondNineHundredNinetyNineMilliseconds() {
        assertFalse(TunnelStateMachine.canCancel(TunnelPhase.Connecting(a, 0), 1_999))
    }

    @Test
    fun canCancelIsTrueAtTwoSeconds() {
        assertTrue(TunnelStateMachine.canCancel(TunnelPhase.Connecting(a, 0), 2_000))
    }

    @Test
    fun isPendingCoversConnectingAndDisconnectingOnly() {
        assertTrue(TunnelStateMachine.isPending(TunnelPhase.Connecting(a, 0)))
        assertTrue(TunnelStateMachine.isPending(TunnelPhase.Disconnecting(a, 0)))
        assertFalse(TunnelStateMachine.isPending(TunnelPhase.Connected(a, 0)))
        assertFalse(TunnelStateMachine.isPending(TunnelPhase.Disconnected))
    }
}
