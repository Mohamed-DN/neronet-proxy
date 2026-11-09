package com.darknero.neronet

import java.net.InetAddress
import java.net.URI

/** One [Peer] of a profile, as the UI shows it. */
data class PeerSummary(
    val publicKey: String,
    val endpointHost: String?,
    val endpointPort: Int?,
    val allowedIps: List<String>,
    /** 0 when PersistentKeepalive is off. */
    val keepaliveSeconds: Int,
)

/** A profile reduced to what the UI shows. Built once when a profile is loaded. */
data class ProfileSummary(
    val id: String,
    val title: String,
    val deviceId: String?,
    /** This device's tunnel addresses; /32 (IPv4) and /128 (IPv6) are dropped for display. */
    val addresses: List<String>,
    val dns: List<String>,
    val consoleUrl: String?,
    val peers: List<PeerSummary>,
    val devicePublicKey: String,
) {
    /** The single peer of a normal NeroNet profile; null when there are none or several. */
    val gateway: PeerSummary?
        get() = peers.singleOrNull()

    /** True when any peer allows all IPv4 or all IPv6 traffic through the tunnel. */
    val isFullTunnel: Boolean
        get() = peers.any { peer -> peer.allowedIps.any { it == "0.0.0.0/0" || it == "::/0" } }

    companion object {
        fun from(id: String, profile: NeroNetProfile): ProfileSummary {
            val config = profile.config
            val peers = config.peers.map { peer ->
                val endpoint = peer.endpoint.orElse(null)
                PeerSummary(
                    publicKey = peer.publicKey.toBase64(),
                    endpointHost = endpoint?.host,
                    endpointPort = endpoint?.port,
                    allowedIps = peer.allowedIps.map { it.toString() },
                    keepaliveSeconds = peer.persistentKeepalive.orElse(0),
                )
            }
            val consoleHost = profile.consoleUrl
                ?.let { URI(it).host }
                ?.takeIf { it.isNotEmpty() }
                ?.removePrefix("console.")
            return ProfileSummary(
                id = id,
                title = consoleHost ?: peers.firstOrNull()?.endpointHost ?: "NeroNet ${id.take(4)}",
                deviceId = profile.deviceId,
                addresses = config.`interface`.addresses.map { displayAddress(it.toString()) },
                dns = config.`interface`.dnsServers.map { displayIp(it) },
                consoleUrl = profile.consoleUrl,
                peers = peers,
                devicePublicKey = profile.devicePublicKey,
            )
        }

        /** "100.64.12.34/32" becomes "100.64.12.34"; other prefixes stay. IPv6 is shown in RFC 5952 form. */
        private fun displayAddress(prefix: String): String {
            val slash = prefix.lastIndexOf('/')
            if (slash < 0) return prefix
            val host = prefix.substring(0, slash)
            val bits = prefix.substring(slash + 1)
            val shown = if (host.contains(':')) compressIpv6(host) else host
            return when {
                host.contains(':') && bits == "128" -> shown
                !host.contains(':') && bits == "32" -> shown
                else -> "$shown/$bits"
            }
        }

        private fun displayIp(address: InetAddress): String {
            val text = address.hostAddress
            return if (text.contains(':')) compressIpv6(text) else text
        }

        /** RFC 5952: the longest run of two or more zero groups becomes "::". The library prints all eight groups. */
        private fun compressIpv6(literal: String): String {
            val bytes = InetAddress.getByName(literal).address
            val groups = IntArray(8) { ((bytes[2 * it].toInt() and 0xff) shl 8) or (bytes[2 * it + 1].toInt() and 0xff) }
            var bestStart = -1
            var bestLen = 0
            var i = 0
            while (i < 8) {
                if (groups[i] == 0) {
                    var j = i
                    while (j < 8 && groups[j] == 0) j++
                    if (j - i >= 2 && j - i > bestLen) {
                        bestStart = i
                        bestLen = j - i
                    }
                    i = j
                } else {
                    i++
                }
            }
            val hex = groups.map { Integer.toHexString(it) }
            return if (bestStart < 0) {
                hex.joinToString(":")
            } else {
                hex.subList(0, bestStart).joinToString(":") + "::" + hex.subList(bestStart + bestLen, 8).joinToString(":")
            }
        }
    }
}
