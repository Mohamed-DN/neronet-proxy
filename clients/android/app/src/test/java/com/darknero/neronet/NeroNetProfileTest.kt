package com.darknero.neronet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

class NeroNetProfileTest {

    // Fake 32-byte keys generated for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private val privateKey = fakeKey(1)
    private val publicKey = fakeKey(50)
    private val presharedKey = fakeKey(90)

    private val header = "# NeroNet-Profile: 1\n" +
        "# NeroNet-Console: https://console.example/me\n" +
        "# NeroNet-Device: dev-0123abcd\n"

    private fun iface(extra: String = "") =
        "[Interface]\nPrivateKey = $privateKey\nAddress = 100.64.12.34/32\nDNS = 100.64.0.1\n$extra"

    private fun peer(extra: String = "") =
        "[Peer]\nPublicKey = $publicKey\nPresharedKey = $presharedKey\n" +
            "Endpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\nPersistentKeepalive = 25\n$extra"

    private fun profile(
        head: String = header,
        ifaceText: String = iface(),
        peerText: String = peer(),
    ) = head + ifaceText + peerText

    @Test
    fun parsesAValidProfile() {
        val p = NeroNetProfile.parse(profile())
        assertEquals(1, p.version)
        assertEquals("https://console.example/me", p.consoleUrl)
        assertEquals("dev-0123abcd", p.deviceId)
        assertEquals(1, p.config.peers.size)
    }

    @Test
    fun acceptsAPlainWireGuardFileAsVersionZero() {
        val p = NeroNetProfile.parse(profile(head = ""))
        assertEquals(0, p.version)
        assertNull(p.consoleUrl)
        assertNull(p.deviceId)
    }

    @Test
    fun ignoresPlainCommentsAndUnknownNeroNetLines() {
        val p = NeroNetProfile.parse("# a note\n# NeroNet-Future: something\n" + profile())
        assertEquals(1, p.version)
    }

    @Test
    fun acceptsPersistentKeepaliveOff() {
        val p = NeroNetProfile.parse(profile(peerText = peer().replace("= 25", "= off")))
        assertEquals(1, p.config.peers.size)
    }

    @Test
    fun rejectsOtherProfileVersions() {
        for (v in listOf("0", "2", "99", "x")) {
            assertThrows(v, ProfileException::class.java) {
                NeroNetProfile.parse(profile(head = header.replace("NeroNet-Profile: 1", "NeroNet-Profile: $v")))
            }
        }
    }

    @Test
    fun rejectsAConsoleThatIsNotHttps() {
        for (url in listOf("http://console.example/me", "console.example/me", "ftp://console.example", "https://")) {
            assertThrows(url, ProfileException::class.java) {
                NeroNetProfile.parse(profile(head = header.replace("https://console.example/me", url)))
            }
        }
    }

    @Test
    fun rejectsKeysThatRunCommandsOrChangeRouting() {
        for (line in listOf("PostUp = echo hi", "PostDown = echo bye", "PreUp = x", "PreDown = y", "Table = off", "SaveConfig = true")) {
            assertThrows(line, ProfileException::class.java) {
                NeroNetProfile.parse(profile(ifaceText = iface("$line\n")))
            }
        }
    }

    @Test
    fun rejectsAnyKeyItDoesNotKnow() {
        assertThrows(ProfileException::class.java) {
            NeroNetProfile.parse(profile(ifaceText = iface("FwMark = 51820\n")))
        }
    }

    @Test
    fun rejectsKeysThatAreNotThirtyTwoBytes() {
        val short = "AAAA="
        assertThrows(ProfileException::class.java) {
            NeroNetProfile.parse(profile(ifaceText = iface().replace(privateKey, short)))
        }
        assertThrows(ProfileException::class.java) {
            NeroNetProfile.parse(profile(peerText = peer().replace(publicKey, short)))
        }
    }

    @Test
    fun rejectsAMissingPrivateKeyOrPeer() {
        assertThrows(ProfileException::class.java) {
            NeroNetProfile.parse(profile(ifaceText = "[Interface]\nAddress = 100.64.12.34/32\n"))
        }
        assertThrows(ProfileException::class.java) {
            NeroNetProfile.parse(profile(peerText = ""))
        }
    }

    @Test
    fun rejectsAPeerWithoutPublicKey() {
        assertThrows(ProfileException::class.java) {
            NeroNetProfile.parse(profile(peerText = "[Peer]\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n"))
        }
    }

    @Test
    fun rejectsBadEndpoints() {
        for (endpoint in listOf("gateway.example", "gateway.example:0", "gateway.example:70000", ":51820", "gateway.example:")) {
            assertThrows(endpoint, ProfileException::class.java) {
                NeroNetProfile.parse(profile(peerText = peer().replace("gateway.example:51820", endpoint)))
            }
        }
    }

    @Test
    fun rejectsSearchDomainsAndHostNamesInDns() {
        assertThrows(ProfileException::class.java) {
            NeroNetProfile.parse(profile(ifaceText = iface().replace("DNS = 100.64.0.1", "DNS = 100.64.0.1, corp.example")))
        }
    }

    @Test
    fun rejectsAllowedIpsThatAreNotPrefixes() {
        assertThrows(ProfileException::class.java) {
            NeroNetProfile.parse(profile(peerText = peer().replace("100.64.0.0/10", "100.64.0.0/33")))
        }
    }

    @Test
    fun rejectsUnknownSections() {
        assertThrows(ProfileException::class.java) {
            NeroNetProfile.parse(profile(peerText = peer("\n[Hook]\nRun = x\n")))
        }
    }

    @Test
    fun errorMessagesNeverContainKeyMaterial() {
        val bad = "AAAA="
        val e = assertThrows(ProfileException::class.java) {
            NeroNetProfile.parse(profile(peerText = peer().replace(presharedKey, bad)))
        }
        assertTrue(e.message!!.contains("PresharedKey"))
        assertFalse(e.message!!.contains(bad))
        assertFalse(e.message!!.contains(privateKey))
    }
}
