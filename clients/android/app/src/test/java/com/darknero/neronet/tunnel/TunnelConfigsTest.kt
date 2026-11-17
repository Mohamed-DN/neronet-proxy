package com.darknero.neronet.tunnel

import com.darknero.neronet.NeroNetProfile
import com.wireguard.config.InetNetwork
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class TunnelConfigsTest {

    // The library prints an IPv6 prefix with all eight groups, so compare with its own form.
    private val BLOCK_AS_PRINTED = TunnelConfigs.BLOCK_ROUTES.map { InetNetwork.parse(it).toString() }

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private val real = NeroNetProfile.parse(
        "# NeroNet-Profile: 1\n" +
            "[Interface]\nPrivateKey = ${fakeKey(1)}\nAddress = 100.64.12.34/32, fd7a::1234/128\nDNS = 100.100.100.100\n" +
            "[Peer]\nPublicKey = ${fakeKey(50)}\nEndpoint = gateway.example:51820\nAllowedIPs = 0.0.0.0/0, ::/0\n" +
            "PersistentKeepalive = 25\n",
    ).config

    @Test
    fun blockRoutesAreAllTrafficOfBothFamilies() {
        assertEquals(listOf("0.0.0.0/0", "::/0"), TunnelConfigs.BLOCK_ROUTES)
        assertEquals(BLOCK_AS_PRINTED, TunnelConfigs.routesOf(TunnelConfigs.blocking(real)))
    }

    @Test
    fun blockRoutesAreAllTrafficEvenWhenTheProfileIsASplitOne() {
        val split = NeroNetProfile.parse(
            "[Interface]\nPrivateKey = ${fakeKey(1)}\nAddress = 100.64.12.34/32\n" +
                "[Peer]\nPublicKey = ${fakeKey(50)}\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n",
        ).config
        assertEquals(BLOCK_AS_PRINTED, TunnelConfigs.routesOf(TunnelConfigs.blocking(split)))
    }

    @Test
    fun blockingInterfaceHasNoEndpointAndNoRealGatewayKey() {
        val block = TunnelConfigs.blocking(real)
        val peer = block.peers.single()
        assertTrue(peer.endpoint.isEmpty)
        assertTrue(peer.persistentKeepalive.isEmpty)
        assertNotEquals(real.peers.single().publicKey, peer.publicKey)
    }

    @Test
    fun blockingInterfaceKeepsTheDeviceKeyAndAddressesButNotDns() {
        val block = TunnelConfigs.blocking(real)
        assertEquals(real.`interface`.keyPair.publicKey, block.`interface`.keyPair.publicKey)
        assertEquals(real.`interface`.addresses, block.`interface`.addresses)
        assertTrue(block.`interface`.dnsServers.isEmpty())
    }

    @Test
    fun eachBlockUsesAFreshPeerKey() {
        val first = TunnelConfigs.blocking(real).peers.single().publicKey
        val second = TunnelConfigs.blocking(real).peers.single().publicKey
        assertNotEquals(first, second)
    }
}
