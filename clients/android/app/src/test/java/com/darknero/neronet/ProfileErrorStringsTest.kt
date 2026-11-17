package com.darknero.neronet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.util.Base64

class ProfileErrorStringsTest {

    // Fake 32-byte keys generated for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private val privateKey = fakeKey(1)
    private val publicKey = fakeKey(50)

    private val header = "# NeroNet-Profile: 1\n" +
        "# NeroNet-Console: https://console.example/me\n" +
        "# NeroNet-Device: dev-0123abcd\n"

    private fun iface(extra: String = "") =
        "[Interface]\nPrivateKey = $privateKey\nAddress = 100.64.12.34/32\nDNS = 100.64.0.1\n$extra"

    private fun peer(extra: String = "") =
        "[Peer]\nPublicKey = $publicKey\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n$extra"

    private fun profile(head: String = header, ifaceText: String = iface(), peerText: String = peer()) =
        head + ifaceText + peerText

    @Test
    fun everyReasonHasItsOwnNonZeroString() {
        val ids = ProfileReason.values().map { ProfileErrorStrings.forReason(it) }
        ids.forEach { assertNotEquals(0, it) }
        assertEquals(ProfileReason.values().size, ids.toSet().size)
    }

    @Test
    fun anyOtherFailureFallsBackToTheGenericText() {
        assertEquals(R.string.reason_other, ProfileErrorStrings.forThrowable(IllegalStateException("boom")))
        assertEquals(R.string.reason_other, ProfileErrorStrings.forThrowable(RuntimeException()))
    }

    @Test
    fun aProfileExceptionMapsToItsReasonString() {
        val e = ProfileException(ProfileReason.BAD_VALUE, "English detail for developers")
        assertEquals(R.string.reason_bad_value, ProfileErrorStrings.forThrowable(e))
    }

    @Test
    fun parseFailuresMapToTheirLocalizedReason() {
        assertRejects(R.string.reason_version, "# NeroNet-Profile: 2\n" + iface() + peer())
        assertRejects(R.string.reason_console_https, profile(head = header.replace("https://", "http://")))
        assertRejects(R.string.reason_refused_setting, profile(ifaceText = iface("PostUp = echo hi\n")))
        assertRejects(R.string.reason_unknown_setting, profile(ifaceText = iface("FwMark = 51820\n")))
        assertRejects(R.string.reason_unknown_section, profile(peerText = peer("\n[Hook]\nRun = x\n")))
        assertRejects(R.string.reason_syntax, profile(ifaceText = iface("garbage line\n")))
        assertRejects(
            R.string.reason_bad_value,
            profile(ifaceText = iface().replace("DNS = 100.64.0.1", "DNS = corp.example")),
        )
        assertRejects(
            R.string.reason_missing_private_key,
            profile(ifaceText = "[Interface]\nAddress = 100.64.12.34/32\n"),
        )
        assertRejects(R.string.reason_missing_peer, profile(peerText = ""))
        assertRejects(
            R.string.reason_missing_public_key,
            profile(peerText = "[Peer]\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n"),
        )
    }

    private fun assertRejects(expectedStringRes: Int, text: String) {
        val e = assertThrows(ProfileException::class.java) { NeroNetProfile.parse(text) }
        assertEquals(expectedStringRes, ProfileErrorStrings.forThrowable(e))
    }
}
