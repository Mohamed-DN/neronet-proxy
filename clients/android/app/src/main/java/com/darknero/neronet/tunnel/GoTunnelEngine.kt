package com.darknero.neronet.tunnel

import android.content.Context
import com.darknero.neronet.NeroNetProfile
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The WireGuard library's GoBackend behind [TunnelEngine]. One backend and one Tunnel object per profile. */
class GoTunnelEngine(context: Context, alwaysOn: () -> Unit) : TunnelEngine {

    private val backend = GoBackend(context.applicationContext)

    // The backend compares tunnels by instance, so keep one object per profile for the process.
    private val tunnels = mutableMapOf<String, Tunnel>()

    // Every backend call runs here, one at a time, so two calls never race inside the library.
    private val backendThread = Dispatchers.IO.limitedParallelism(1)

    @Volatile
    private var listener: ((String, Boolean) -> Unit)? = null

    init {
        GoBackend.setAlwaysOnCallback { alwaysOn() }
    }

    private fun tunnel(id: String): Tunnel = synchronized(tunnels) {
        tunnels.getOrPut(id) {
            object : Tunnel {
                override fun getName(): String = "nn_$id"
                override fun onStateChange(newState: Tunnel.State) {
                    listener?.invoke(id, newState == Tunnel.State.UP)
                }
            }
        }
    }

    override fun setListener(listener: (profileId: String, up: Boolean) -> Unit) {
        this.listener = listener
    }

    override suspend fun up(profileId: String, profile: NeroNetProfile) {
        // GoBackend brings any tunnel that is already up down before this one comes up.
        withContext(backendThread) {
            backend.setState(tunnel(profileId), Tunnel.State.UP, profile.config)
            Unit
        }
    }

    override suspend fun down(profileId: String) {
        withContext(backendThread) {
            backend.setState(tunnel(profileId), Tunnel.State.DOWN, null)
            Unit
        }
    }

    override suspend fun stats(profileId: String): TunnelStats? = withContext(backendThread) {
        val target = tunnel(profileId)
        if (backend.getState(target) != Tunnel.State.UP) return@withContext null
        val stats = backend.getStatistics(target)
        TunnelStats(
            rxBytes = stats.totalRx(),
            txBytes = stats.totalTx(),
            lastHandshakeWallMs = stats.peers().associate { key ->
                key.toBase64() to (stats.peer(key)?.latestHandshakeEpochMillis() ?: 0L)
            },
        )
    }
}
