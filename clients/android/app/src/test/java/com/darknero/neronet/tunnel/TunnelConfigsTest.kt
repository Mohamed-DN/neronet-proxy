package com.darknero.neronet.tunnel

import com.darknero.neronet.NeroNetProfile
import com.wireguard.config.InetNetwork
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertSame
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

    // Split tunnelling (ADR 0035)

    @Test
    fun includeOnlyListGoesIntoTheInterface() {
        val rules = AppRules(AppRuleMode.INCLUDE_ONLY, setOf("org.example.mail", "org.example.chat"))

        val config = TunnelConfigs.withAppRules(real, rules)

        assertEquals(setOf("org.example.mail", "org.example.chat"), config.`interface`.includedApplications)
        assertTrue(config.`interface`.excludedApplications.isEmpty())
    }

    @Test
    fun excludeListGoesIntoTheInterface() {
        val rules = AppRules(AppRuleMode.EXCLUDE, setOf("org.example.bank"))

        val config = TunnelConfigs.withAppRules(real, rules)

        assertEquals(setOf("org.example.bank"), config.`interface`.excludedApplications)
        assertTrue(config.`interface`.includedApplications.isEmpty())
    }

    @Test
    fun rulesChangeNothingElseInTheConfig() {
        val config = TunnelConfigs.withAppRules(real, AppRules(AppRuleMode.EXCLUDE, setOf("org.example.bank")))

        assertEquals(real.`interface`.keyPair.publicKey, config.`interface`.keyPair.publicKey)
        assertEquals(real.`interface`.addresses, config.`interface`.addresses)
        assertEquals(real.`interface`.dnsServers, config.`interface`.dnsServers)
        assertEquals(real.peers, config.peers)
    }

    @Test
    fun noRuleAndEmptyListsReturnTheConfigAsItIs() {
        assertSame(real, TunnelConfigs.withAppRules(real, AppRules.NONE))
        assertSame(real, TunnelConfigs.withAppRules(real, AppRules(AppRuleMode.EXCLUDE, emptySet())))
        // An include-only mode without apps would mean "all apps" to Android, so it is no rule either.
        assertSame(real, TunnelConfigs.withAppRules(real, AppRules(AppRuleMode.INCLUDE_ONLY, emptySet())))
        assertSame(real, TunnelConfigs.withAppRules(real, AppRules(AppRuleMode.ALL, setOf("org.example.mail"))))
    }

    @Test
    fun theOriginalConfigIsNotChanged() {
        TunnelConfigs.withAppRules(real, AppRules(AppRuleMode.INCLUDE_ONLY, setOf("org.example.mail")))

        assertTrue(real.`interface`.includedApplications.isEmpty())
        assertTrue(real.`interface`.excludedApplications.isEmpty())
    }

    @Test
    fun theBlockingInterfaceKeepsTheAppRules() {
        val config = TunnelConfigs.withAppRules(real, AppRules(AppRuleMode.EXCLUDE, setOf("org.example.bank")))

        val block = TunnelConfigs.blocking(config)

        assertEquals(setOf("org.example.bank"), block.`interface`.excludedApplications)
    }
}
