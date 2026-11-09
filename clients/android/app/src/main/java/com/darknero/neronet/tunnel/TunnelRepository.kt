package com.darknero.neronet.tunnel

import com.darknero.neronet.NeroNetProfile
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Owns the tunnel state. Events go through [TunnelStateMachine]; the effects it asks for (start or stop a
 * tunnel) run one at a time on [scope], and the engine's answers come back as events.
 */
class TunnelRepository(
    private val engine: TunnelEngine,
    private val profileLookup: (String) -> NeroNetProfile?,
    private val clock: Clock,
    private val scope: CoroutineScope,
) {
    private val lock = Any()
    private val machine = MutableStateFlow(MachineState())
    val state: StateFlow<MachineState> = machine.asStateFlow()

    private val effects = Channel<TunnelEffect>(Channel.UNLIMITED)
    private var ticker: Job? = null

    init {
        engine.setListener { profileId, up ->
            val now = clock.elapsedMs()
            dispatch(if (up) TunnelEvent.BackendUp(profileId, now) else TunnelEvent.BackendDown(profileId, now))
        }
        scope.launch {
            for (effect in effects) run(effect)
        }
    }

    fun connect(profileId: String) = dispatch(TunnelEvent.UserConnect(profileId, clock.elapsedMs()))

    fun disconnect() = dispatch(TunnelEvent.UserDisconnect(clock.elapsedMs()))

    fun cancel() = dispatch(TunnelEvent.UserCancel(clock.elapsedMs()))

    fun dismissError() = dispatch(TunnelEvent.UserDismissError)

    fun permissionDenied(profileId: String?) = dispatch(TunnelEvent.PermissionDenied(profileId))

    fun alwaysOnStarted(profileId: String?) = dispatch(TunnelEvent.AlwaysOnStarted(profileId, clock.elapsedMs()))

    /** Traffic of the connected profile; null when nothing is connected or the backend cannot say. */
    suspend fun stats(): TunnelStats? {
        val connected = machine.value.phase as? TunnelPhase.Connected ?: return null
        return try {
            engine.stats(connected.profileId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            null
        }
    }

    /** Wall-clock time at which the current Connected phase began, or null when not connected. */
    fun connectedWallSinceMs(): Long? {
        val connected = machine.value.phase as? TunnelPhase.Connected ?: return null
        return clock.wallMs() - (clock.elapsedMs() - connected.sinceMs)
    }

    private fun dispatch(event: TunnelEvent) {
        val transition = synchronized(lock) {
            val next = TunnelStateMachine.reduce(machine.value, event)
            machine.value = next.state
            next
        }
        if (transition.effect != TunnelEffect.None) effects.trySend(transition.effect)
        if (TunnelStateMachine.isPending(machine.value.phase)) startTicker()
    }

    /** One ticker at a time, running only while a phase waits for the engine. */
    private fun startTicker() {
        if (ticker?.isActive == true) return
        ticker = scope.launch {
            while (TunnelStateMachine.isPending(machine.value.phase)) {
                delay(TunnelTimings.TICK_MS)
                dispatch(TunnelEvent.Tick(clock.elapsedMs()))
            }
        }
    }

    private suspend fun run(effect: TunnelEffect) {
        when (effect) {
            TunnelEffect.None -> Unit
            is TunnelEffect.StartTunnel -> {
                val profile = profileLookup(effect.profileId)
                if (profile == null) {
                    dispatch(TunnelEvent.BackendFailed(effect.profileId, TunnelError.PROFILE_MISSING))
                    return
                }
                try {
                    engine.up(effect.profileId, profile)
                    dispatch(TunnelEvent.BackendUp(effect.profileId, clock.elapsedMs()))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    dispatch(TunnelEvent.BackendFailed(effect.profileId, tunnelErrorOf(e)))
                }
            }
            is TunnelEffect.StopTunnel -> {
                try {
                    engine.down(effect.profileId)
                    dispatch(TunnelEvent.BackendDown(effect.profileId, clock.elapsedMs()))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    dispatch(TunnelEvent.BackendFailed(effect.profileId, tunnelErrorOf(e)))
                }
            }
        }
    }
}
