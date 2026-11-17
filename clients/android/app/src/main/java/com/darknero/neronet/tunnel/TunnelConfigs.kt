package com.darknero.neronet.tunnel

import com.wireguard.config.Config
import com.wireguard.config.InetNetwork
import com.wireguard.config.Interface
import com.wireguard.config.Peer
import com.wireguard.crypto.KeyPair

/** The configurations the app brings up besides the profile itself. */
object TunnelConfigs {

    /** The routes of the blocking interface: everything, both families. */
    val BLOCK_ROUTES: List<String> = listOf("0.0.0.0/0", "::/0")

    /**
     * The kill switch's interface (ADR 0035): the device's own addresses, one peer with all routes and
     * no endpoint, so the VPN interface takes every packet and WireGuard has nowhere to send it. The peer
     * key is random and used only here; no real gateway key or endpoint is involved.
     * Per-app rules of [real] are kept, so apps outside the tunnel stay outside while it is blocked.
     */
    fun blocking(real: Config): Config {
        val source = real.`interface`
        val iface = Interface.Builder()
            .setKeyPair(source.keyPair)
            .addAddresses(source.addresses)
            .excludeApplications(source.excludedApplications)
            .includeApplications(source.includedApplications)
            .build()
        val peer = Peer.Builder()
            .setPublicKey(KeyPair().publicKey)
            .addAllowedIps(BLOCK_ROUTES.map { InetNetwork.parse(it) })
            .build()
        return Config.Builder().setInterface(iface).addPeer(peer).build()
    }

    /** The prefixes the interface of [config] routes into the tunnel, as written in the config. */
    fun routesOf(config: Config): List<String> =
        config.peers.flatMap { peer -> peer.allowedIps.map { it.toString() } }
}
