package com.darknero.neronet

import android.content.Context
import com.wireguard.android.backend.GoBackend
import com.wireguard.android.backend.Tunnel

/** Brings profile tunnels up and down with the WireGuard library's GoBackend. */
class TunnelController(context: Context) {

    class Traffic(val rx: Long, val tx: Long, val lastHandshakeMillis: Long)

    private val backend = GoBackend(context.applicationContext)

    // The backend compares tunnels by instance, so keep one object per profile for the process.
    private val tunnels = mutableMapOf<String, Tunnel>()

    private fun tunnel(id: String): Tunnel = tunnels.getOrPut(id) {
        object : Tunnel {
            override fun getName(): String = "nn_$id"
            override fun onStateChange(newState: Tunnel.State) {}
        }
    }

    fun isUp(id: String): Boolean = backend.getState(tunnel(id)) == Tunnel.State.UP

    /** Brings [id] up. Only one tunnel runs at a time, so the others in [allIds] go down first. */
    fun up(id: String, profile: NeroNetProfile, allIds: List<String>) {
        for (other in allIds) {
            if (other != id && isUp(other)) backend.setState(tunnel(other), Tunnel.State.DOWN, null)
        }
        backend.setState(tunnel(id), Tunnel.State.UP, profile.config)
    }

    fun down(id: String) {
        backend.setState(tunnel(id), Tunnel.State.DOWN, null)
    }

    fun traffic(id: String): Traffic {
        val stats = backend.getStatistics(tunnel(id))
        val handshake = stats.peers().mapNotNull { stats.peer(it)?.latestHandshakeEpochMillis() }.maxOrNull() ?: 0L
        return Traffic(stats.totalRx(), stats.totalTx(), handshake)
    }
}
