package com.darknero.neronet.tunnel

import com.wireguard.config.Config

/** Traffic counters and handshake times of one tunnel. [lastHandshakeWallMs] maps a peer's public key to epoch ms; 0 means never. */
data class TunnelStats(val rxBytes: Long, val txBytes: Long, val lastHandshakeWallMs: Map<String, Long>)

/**
 * The boundary between the repository and the WireGuard backend. The listener receives the backend's own
 * state changes (profile id, true when up); [up], [block] and [down] throw when the backend refuses.
 */
interface TunnelEngine {
    fun setListener(listener: (profileId: String, up: Boolean) -> Unit)
    suspend fun up(profileId: String, config: Config)

    /** Brings up [config] (see [TunnelConfigs.blocking]) in place of the tunnel, so traffic cannot leave outside it. */
    suspend fun block(profileId: String, config: Config)
    suspend fun down(profileId: String)
    suspend fun stats(profileId: String): TunnelStats?
}
