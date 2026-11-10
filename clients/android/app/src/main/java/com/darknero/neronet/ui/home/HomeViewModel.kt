package com.darknero.neronet.ui.home

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.darknero.neronet.NeroNetApplication
import com.darknero.neronet.ProfileRepository
import com.darknero.neronet.tunnel.Clock
import com.darknero.neronet.tunnel.MachineState
import com.darknero.neronet.tunnel.SystemClockSource
import com.darknero.neronet.tunnel.TunnelPhase
import com.darknero.neronet.tunnel.TunnelRepository
import com.darknero.neronet.tunnel.TunnelStats
import com.darknero.neronet.tunnel.TunnelTimings
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn

class HomeViewModel(
    private val tunnels: TunnelRepository,
    private val profiles: ProfileRepository,
    private val clock: Clock,
) : ViewModel() {

    private class Now(val elapsedMs: Long, val wallMs: Long)

    private val ticker: Flow<Now> = flow {
        while (true) {
            emit(Now(clock.elapsedMs(), clock.wallMs()))
            delay(TICK_MS)
        }
    }

    /** Traffic is polled only while connected; otherwise the stream emits null once and waits. */
    private val stats: Flow<TunnelStats?> = tunnels.state
        .map { it.phase is TunnelPhase.Connected }
        .distinctUntilChanged()
        .flatMapLatest { connected ->
            if (!connected) {
                flowOf(null)
            } else {
                flow {
                    while (true) {
                        emit(tunnels.stats())
                        delay(TunnelTimings.STATS_POLL_MS)
                    }
                }
            }
        }

    val uiState: StateFlow<HomeUiState> = combine(
        tunnels.state,
        profiles.profiles,
        profiles.selectedId,
        stats,
        ticker,
    ) { machine, all, selected, latestStats, now ->
        val profileId = machine.phase.profileIdOrNull() ?: selected
        buildHomeUiState(
            machine = machine,
            profile = all.firstOrNull { it.id == profileId },
            hasProfiles = all.isNotEmpty(),
            stats = latestStats,
            nowElapsedMs = now.elapsedMs,
            nowWallMs = now.wallMs,
        )
    }.stateIn(
        viewModelScope,
        SharingStarted.WhileSubscribed(STOP_AFTER_MS),
        buildHomeUiState(MachineState(), null, hasProfiles = false, stats = null, nowElapsedMs = 0, nowWallMs = 0),
    )

    /** Switch on connects the selected profile; switch off cancels a connecting tunnel or disconnects a connected one. */
    fun onToggle(on: Boolean) {
        if (on) {
            val id = profiles.selectedId.value ?: return
            tunnels.connect(id)
            return
        }
        when (tunnels.state.value.phase) {
            is TunnelPhase.Connecting -> tunnels.cancel()
            is TunnelPhase.Connected -> tunnels.disconnect()
            else -> Unit
        }
    }

    fun onCancel() = tunnels.cancel()

    fun onDismissError() = tunnels.dismissError()

    fun onPermissionDenied() = tunnels.permissionDenied(profiles.selectedId.value)

    fun onRetry() = onToggle(true)

    companion object {
        private const val TICK_MS = 1_000L
        private const val STOP_AFTER_MS = 5_000L

        fun factory(app: NeroNetApplication): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                HomeViewModel(app.tunnels, app.profiles, SystemClockSource) as T
        }
    }
}

private fun TunnelPhase.profileIdOrNull(): String? = when (this) {
    TunnelPhase.Disconnected -> null
    is TunnelPhase.Connecting -> profileId
    is TunnelPhase.Connected -> profileId
    is TunnelPhase.Disconnecting -> profileId
    is TunnelPhase.Error -> profileId
}
