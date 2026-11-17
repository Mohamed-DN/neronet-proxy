package com.darknero.neronet.tunnel

/** Why a tunnel is in [TunnelPhase.Error]. The UI maps each value to a sentence; see the copy in strings.xml. */
enum class TunnelError {
    VPN_PERMISSION_DENIED,
    VPN_REVOKED,
    TIMEOUT,
    UNABLE_TO_START_VPN,
    DNS_RESOLUTION_FAILURE,
    TUN_CREATION_ERROR,
    GO_ACTIVATION_ERROR,
    PROFILE_MISSING,
    DISCONNECT_TIMEOUT,
    UNKNOWN,
}

/** What the tunnel is doing, as observed from the WireGuard backend and from the user's requests. */
sealed interface TunnelPhase {
    data object Disconnected : TunnelPhase
    data class Connecting(val profileId: String, val sinceMs: Long) : TunnelPhase
    data class Connected(val profileId: String, val sinceMs: Long) : TunnelPhase
    data class Disconnecting(val profileId: String, val sinceMs: Long) : TunnelPhase
    data class Error(val reason: TunnelError, val profileId: String?) : TunnelPhase

    /**
     * The kill switch is holding traffic after an unexpected drop (ADR 0035). The app keeps a VPN interface
     * that routes everything and reaches no peer, and retries the real tunnel until it is back or the person
     * turns the tunnel off. [attempt] counts the failed retries; [retrying] is true while one is running.
     */
    data class Reconnecting(
        val profileId: String,
        val sinceMs: Long,
        val attempt: Int,
        val nextRetryMs: Long,
        val retrying: Boolean = false,
    ) : TunnelPhase
}

/** The phase plus [wantConnected], the user's intent, which is kept apart from what the backend reports. */
data class MachineState(
    val phase: TunnelPhase = TunnelPhase.Disconnected,
    val wantConnected: Boolean = false,
)

sealed interface TunnelEvent {
    data class UserConnect(val profileId: String, val nowMs: Long) : TunnelEvent
    data class UserDisconnect(val nowMs: Long) : TunnelEvent
    data class UserCancel(val nowMs: Long) : TunnelEvent
    data object UserDismissError : TunnelEvent
    data class PermissionDenied(val profileId: String?) : TunnelEvent
    data class AlwaysOnStarted(val profileId: String?, val nowMs: Long) : TunnelEvent
    data class BackendUp(val profileId: String, val nowMs: Long) : TunnelEvent

    /** [killSwitch] is the profile's effective kill switch setting at the moment of the drop. */
    data class BackendDown(val profileId: String, val nowMs: Long, val killSwitch: Boolean = false) : TunnelEvent
    data class BackendFailed(val profileId: String, val reason: TunnelError) : TunnelEvent

    /** The kill switch could not hold the traffic (another VPN took over, or the permission is gone). */
    data class BlockFailed(val profileId: String) : TunnelEvent
    data class TunnelRestored(val profileId: String, val nowMs: Long) : TunnelEvent
    data class RetryFailed(val profileId: String, val nowMs: Long) : TunnelEvent
    data class Tick(val nowMs: Long) : TunnelEvent
}

/** Work the repository must do on the engine after a transition. */
sealed interface TunnelEffect {
    data object None : TunnelEffect
    data class StartTunnel(val profileId: String) : TunnelEffect
    data class StopTunnel(val profileId: String) : TunnelEffect

    /** Bring up the interface with all routes and no reachable peer. */
    data class BlockTraffic(val profileId: String) : TunnelEffect

    /** Try the real tunnel again while the block is in place. */
    data class RetryTunnel(val profileId: String) : TunnelEffect
}

data class Transition(val state: MachineState, val effect: TunnelEffect = TunnelEffect.None)

/** Timings from the plan. Every value is a millisecond count. */
object TunnelTimings {
    const val PENDING_TIMEOUT_MS = 7_000L
    const val CANCEL_AFTER_MS = 2_000L
    const val HANDSHAKE_FRESH_MS = 180_000L
    const val FIRST_HANDSHAKE_GRACE_MS = 15_000L
    const val STATS_POLL_MS = 1_000L
    const val TICK_MS = 250L
    const val RECONNECT_FIRST_MS = 3_000L
    const val RECONNECT_MAX_MS = 30_000L

    /** Wait before retry number [attempt] (0 is the first): 3, 6, 12, 24 s, then 30 s. */
    fun reconnectDelayMs(attempt: Int): Long =
        minOf(RECONNECT_MAX_MS, RECONNECT_FIRST_MS shl minOf(attempt, 4))
}

/**
 * The tunnel state machine. Pure: no Android types, no clock. Each row of the plan's transition table
 * is one branch here; any (phase, event) pair not in the table returns the state unchanged with no effect.
 */
object TunnelStateMachine {

    fun reduce(state: MachineState, event: TunnelEvent): Transition {
        val phase = state.phase
        val unchanged = Transition(state)
        return when (event) {
            is TunnelEvent.UserConnect -> when {
                phase is TunnelPhase.Disconnected || phase is TunnelPhase.Error -> start(event.profileId, event.nowMs)
                phase is TunnelPhase.Connected && phase.profileId != event.profileId -> start(event.profileId, event.nowMs)
                phase is TunnelPhase.Reconnecting && phase.profileId != event.profileId -> start(event.profileId, event.nowMs)
                else -> unchanged
            }

            is TunnelEvent.UserCancel -> when {
                phase is TunnelPhase.Connecting && canCancel(phase, event.nowMs) -> stopping(phase.profileId, event.nowMs)
                phase is TunnelPhase.Reconnecting -> stopping(phase.profileId, event.nowMs)
                else -> unchanged
            }

            is TunnelEvent.UserDisconnect -> when {
                phase is TunnelPhase.Connecting && canCancel(phase, event.nowMs) -> stopping(phase.profileId, event.nowMs)
                phase is TunnelPhase.Connected -> stopping(phase.profileId, event.nowMs)
                // Turning the tunnel off is the way out of the kill switch's block.
                phase is TunnelPhase.Reconnecting -> stopping(phase.profileId, event.nowMs)
                else -> unchanged
            }

            is TunnelEvent.UserDismissError ->
                if (phase is TunnelPhase.Error) Transition(MachineState(TunnelPhase.Disconnected, false)) else unchanged

            is TunnelEvent.PermissionDenied ->
                if (phase is TunnelPhase.Disconnected || phase is TunnelPhase.Error) {
                    Transition(MachineState(TunnelPhase.Error(TunnelError.VPN_PERMISSION_DENIED, event.profileId), false))
                } else {
                    unchanged
                }

            is TunnelEvent.AlwaysOnStarted -> when {
                phase !is TunnelPhase.Disconnected && phase !is TunnelPhase.Error -> unchanged
                event.profileId == null ->
                    Transition(MachineState(TunnelPhase.Error(TunnelError.PROFILE_MISSING, null), false))
                else -> start(event.profileId, event.nowMs)
            }

            is TunnelEvent.BackendUp -> when {
                phase is TunnelPhase.Connecting && phase.profileId == event.profileId ->
                    Transition(MachineState(TunnelPhase.Connected(event.profileId, event.nowMs), true))
                phase is TunnelPhase.Disconnected ->
                    Transition(MachineState(TunnelPhase.Connected(event.profileId, event.nowMs), true))
                // While Reconnecting the backend's "up" is the blocking interface or a retry; only
                // TunnelRestored, sent when a retry succeeds, ends the block.
                else -> unchanged
            }

            is TunnelEvent.BackendDown -> when {
                phase is TunnelPhase.Connected && phase.profileId == event.profileId && state.wantConnected && event.killSwitch ->
                    // Dropped although the user asked for it: hold the traffic instead of letting it out.
                    Transition(
                        MachineState(
                            TunnelPhase.Reconnecting(
                                profileId = event.profileId,
                                sinceMs = event.nowMs,
                                attempt = 0,
                                nextRetryMs = event.nowMs + TunnelTimings.reconnectDelayMs(0),
                            ),
                            true,
                        ),
                        TunnelEffect.BlockTraffic(event.profileId),
                    )
                phase is TunnelPhase.Connected && phase.profileId == event.profileId && state.wantConnected ->
                    // The tunnel went down although the user asked for it: another VPN or the system took it.
                    Transition(MachineState(TunnelPhase.Error(TunnelError.VPN_REVOKED, event.profileId), false))
                phase is TunnelPhase.Disconnecting && phase.profileId == event.profileId ->
                    Transition(MachineState(TunnelPhase.Disconnected, false))
                phase is TunnelPhase.Error && phase.reason == TunnelError.DISCONNECT_TIMEOUT &&
                    phase.profileId == event.profileId ->
                    Transition(MachineState(TunnelPhase.Disconnected, false))
                else -> unchanged
            }

            is TunnelEvent.BackendFailed -> when {
                phase is TunnelPhase.Connecting && phase.profileId == event.profileId ->
                    Transition(MachineState(TunnelPhase.Error(event.reason, event.profileId), false))
                phase is TunnelPhase.Disconnecting && phase.profileId == event.profileId ->
                    Transition(MachineState(TunnelPhase.Error(event.reason, event.profileId), false))
                else -> unchanged
            }

            is TunnelEvent.BlockFailed ->
                if (phase is TunnelPhase.Reconnecting && phase.profileId == event.profileId) {
                    Transition(MachineState(TunnelPhase.Error(TunnelError.VPN_REVOKED, event.profileId), false))
                } else {
                    unchanged
                }

            is TunnelEvent.TunnelRestored ->
                if (phase is TunnelPhase.Reconnecting && phase.profileId == event.profileId) {
                    Transition(MachineState(TunnelPhase.Connected(event.profileId, event.nowMs), true))
                } else {
                    unchanged
                }

            is TunnelEvent.RetryFailed ->
                if (phase is TunnelPhase.Reconnecting && phase.profileId == event.profileId) {
                    val attempt = phase.attempt + 1
                    Transition(
                        MachineState(
                            phase.copy(
                                attempt = attempt,
                                nextRetryMs = event.nowMs + TunnelTimings.reconnectDelayMs(attempt),
                                retrying = false,
                            ),
                            true,
                        ),
                    )
                } else {
                    unchanged
                }

            is TunnelEvent.Tick -> when {
                phase is TunnelPhase.Connecting && event.nowMs - phase.sinceMs >= TunnelTimings.PENDING_TIMEOUT_MS ->
                    Transition(
                        MachineState(TunnelPhase.Error(TunnelError.TIMEOUT, phase.profileId), false),
                        TunnelEffect.StopTunnel(phase.profileId),
                    )
                phase is TunnelPhase.Disconnecting && event.nowMs - phase.sinceMs >= TunnelTimings.PENDING_TIMEOUT_MS ->
                    Transition(MachineState(TunnelPhase.Error(TunnelError.DISCONNECT_TIMEOUT, phase.profileId), false))
                phase is TunnelPhase.Reconnecting && !phase.retrying && event.nowMs >= phase.nextRetryMs ->
                    Transition(
                        MachineState(phase.copy(retrying = true), true),
                        TunnelEffect.RetryTunnel(phase.profileId),
                    )
                else -> unchanged
            }
        }
    }

    /** True once a connecting tunnel has been pending for the cancel window (2 s). */
    fun canCancel(phase: TunnelPhase, nowMs: Long): Boolean =
        phase is TunnelPhase.Connecting && nowMs - phase.sinceMs >= TunnelTimings.CANCEL_AFTER_MS

    /** Connecting and Disconnecting are the two phases that wait for the engine. */
    fun isPending(phase: TunnelPhase): Boolean =
        phase is TunnelPhase.Connecting || phase is TunnelPhase.Disconnecting

    /** The repository ticks while a phase waits for the engine, and while the kill switch holds the block. */
    fun needsTicks(phase: TunnelPhase): Boolean = isPending(phase) || phase is TunnelPhase.Reconnecting

    private fun start(profileId: String, nowMs: Long): Transition =
        Transition(MachineState(TunnelPhase.Connecting(profileId, nowMs), true), TunnelEffect.StartTunnel(profileId))

    private fun stopping(profileId: String, nowMs: Long): Transition =
        Transition(MachineState(TunnelPhase.Disconnecting(profileId, nowMs), false), TunnelEffect.StopTunnel(profileId))
}
