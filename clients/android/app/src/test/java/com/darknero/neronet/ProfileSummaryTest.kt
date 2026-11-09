package com.darknero.neronet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class ProfileSummaryTest {

    // Fake 32-byte keys generated for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private val privateKey = fakeKey(1)
    private val publicKey = fakeKey(50)
    private val presharedKey = fakeKey(90)
    private val otherPublicKey = fakeKey(120)

    private val header = "# NeroNet-Profile: 1\n" +
        "# NeroNet-Console: https://console.darknero.com/me\n" +
        "# NeroNet-Device: dev-0123abcd\n"

    private fun iface(addresses: String = "100.64.12.34/32") =
        "[Interface]\nPrivateKey = $privateKey\nAddress = $addresses\nDNS = 100.64.0.1\n"

    private fun peer(
        key: String = publicKey,
        endpoint: String? = "gateway.example:51820",
        allowed: String = "100.64.0.0/10",
    ): String = "[Peer]\nPublicKey = $key\nPresharedKey = $presharedKey\n" +
        (endpoint?.let { "Endpoint = $it\n" } ?: "") +
        "AllowedIPs = $allowed\nPersistentKeepalive = 25\n"

    private fun summary(
        head: String = header,
        ifaceText: String = iface(),
        peersText: String = peer(),
        id: String = "abcd1234ef56",
    ): ProfileSummary = ProfileSummary.from(id, NeroNetProfile.parse(head + ifaceText + peersText))

    @Test
    fun titleIsConsoleHostWithoutConsolePrefix() {
        assertEquals("darknero.com", summary().title)
    }

    @Test
    fun titleFallsBackToEndpointHost() {
        val s = summary(head = header.replace(Regex("# NeroNet-Console:.*\n"), ""))
        assertEquals("gateway.example", s.title)
    }

    @Test
    fun titleFallsBackWhenNoConsoleAndNoEndpoint() {
        val s = summary(head = header.replace(Regex("# NeroNet-Console:.*\n"), ""), peersText = peer(endpoint = null))
        assertEquals("NeroNet abcd", s.title)
        assertNull(s.gateway!!.endpointHost)
    }

    @Test
    fun addressesDropHostPrefix() {
        assertEquals(listOf("100.64.12.34"), summary().addresses)
        assertEquals(listOf("fd00::5"), summary(ifaceText = iface("fd00::5/128")).addresses)
        assertEquals(listOf("10.0.0.0/24"), summary(ifaceText = iface("10.0.0.0/24")).addresses)
    }

    @Test
    fun gatewayIsTheOnlyPeer() {
        val s = summary()
        assertEquals(publicKey, s.gateway!!.publicKey)
        assertEquals("gateway.example", s.gateway!!.endpointHost)
        assertEquals(51820, s.gateway!!.endpointPort)
    }

    @Test
    fun twoPeersHaveNoGateway() {
        val s = summary(peersText = peer() + peer(key = otherPublicKey))
        assertNull(s.gateway)
        assertEquals(2, s.peers.size)
    }

    @Test
    fun fullTunnelDetected() {
        assertTrue(summary(peersText = peer(allowed = "0.0.0.0/0, ::/0")).isFullTunnel)
        assertFalse(summary().isFullTunnel)
    }

    @Test
    fun keepaliveOffIsZero() {
        val s = summary(peersText = peer().replace("= 25", "= off"))
        assertEquals(0, s.gateway!!.keepaliveSeconds)
    }

    @Test
    fun devicePublicKeyIsNotThePrivateKey() {
        val key = NeroNetProfile.parse(header + iface() + peer()).devicePublicKey
        assertEquals(44, key.length)
        assertFalse(key == privateKey)
    }
}
