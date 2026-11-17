package com.darknero.neronet.ui.profiles

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.darknero.neronet.AddMethod
import com.darknero.neronet.ImportResult
import com.darknero.neronet.NeroNetApplication
import com.darknero.neronet.ProfileImporter
import com.darknero.neronet.ProfileRepository
import com.darknero.neronet.ProfileSummary
import com.darknero.neronet.tunnel.TunnelPhase
import com.darknero.neronet.tunnel.TunnelRepository
import com.darknero.neronet.tunnel.TunnelTimings
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

class ProfilesViewModel(
    private val profileRepository: ProfileRepository,
    private val tunnels: TunnelRepository,
    private val importer: ProfileImporter,
) : ViewModel() {

    val profiles: StateFlow<List<ProfileSummary>> = profileRepository.profiles
    val selectedId: StateFlow<String?> = profileRepository.selectedId

    /** The profile of a Connecting or Connected tunnel, or null. */
    val activeId: StateFlow<String?> = tunnels.state
        .map { machine -> activeProfileOf(machine.phase) }
        .stateIn(viewModelScope, SharingStarted.WhileSubscribed(STOP_AFTER_MS), null)

    private val importResult = MutableStateFlow<ImportResult?>(null)
    val lastImport: StateFlow<ImportResult?> = importResult.asStateFlow()

    fun consumeImportResult() {
        importResult.value = null
    }

    /** Selecting another profile while one is active connects the new one; the backend brings the old one down. */
    fun select(id: String) {
        val active = activeProfileOf(tunnels.state.value.phase)
        profileRepository.select(id)
        if (active != null && active != id) tunnels.connect(id)
    }

    /**
     * Deleting the active profile first takes its tunnel down, waits for the tunnel to settle (at most
     * the pending timeout), and only then removes the file.
     */
    fun delete(id: String) {
        viewModelScope.launch {
            if (activeProfileOf(tunnels.state.value.phase) == id) {
                tunnels.disconnect()
                withTimeoutOrNull(TunnelTimings.PENDING_TIMEOUT_MS) {
                    tunnels.state.first { machine ->
                        machine.phase is TunnelPhase.Disconnected || machine.phase is TunnelPhase.Error
                    }
                }
            }
            profileRepository.delete(id)
        }
    }

    fun import(text: String, method: AddMethod) {
        importResult.value = if (method == AddMethod.QR) importer.importQr(text) else importer.importText(text)
    }

    companion object {
        private const val STOP_AFTER_MS = 5_000L

        fun factory(app: NeroNetApplication): ViewModelProvider.Factory = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                ProfilesViewModel(app.profiles, app.tunnels, ProfileImporter(app.profiles)) as T
        }
    }
}

private fun activeProfileOf(phase: TunnelPhase): String? = when (phase) {
    is TunnelPhase.Connecting -> phase.profileId
    is TunnelPhase.Connected -> phase.profileId
    else -> null
}
