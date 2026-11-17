package com.darknero.neronet.tunnel

/** Whether the tunnel's last handshake shows the gateway answering. Pure: the caller supplies the ages. */
enum class LinkHealth { WAITING, OK, STALE }

/**
 * [handshakeAgeMs] is the time since the gateway's last handshake, or null when there was none.
 * With the keepalive off an idle tunnel legitimately has an old handshake, so it never goes stale.
 */
fun linkHealth(connectedForMs: Long, handshakeAgeMs: Long?, keepaliveOn: Boolean): LinkHealth = when {
    handshakeAgeMs != null && (handshakeAgeMs <= TunnelTimings.HANDSHAKE_FRESH_MS || !keepaliveOn) -> LinkHealth.OK
    handshakeAgeMs == null && connectedForMs <= TunnelTimings.FIRST_HANDSHAKE_GRACE_MS -> LinkHealth.WAITING
    else -> LinkHealth.STALE
}
