package com.darknero.neronet.tunnel

import com.darknero.neronet.NeroNetProfile

/** Traffic counters and handshake times of one tunnel. [lastHandshakeWallMs] maps a peer's public key to epoch ms; 0 means never. */
data class TunnelStats(val rxBytes: Long, val txBytes: Long, val lastHandshakeWallMs: Map<String, Long>)

/**
 * The boundary between the repository and the WireGuard backend. The listener receives the backend's own
 * state changes (profile id, true when up); [up] and [down] throw when the backend refuses.
 */
interface TunnelEngine {
    fun setListener(listener: (profileId: String, up: Boolean) -> Unit)
    suspend fun up(profileId: String, profile: NeroNetProfile)
    suspend fun down(profileId: String)
    suspend fun stats(profileId: String): TunnelStats?
}
