package com.darknero.neronet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.util.Base64

class ProfileStoreTest {

    @get:Rule
    val folder = TemporaryFolder()

    // Fake 32-byte keys generated for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private val text = "# NeroNet-Profile: 1\n" +
        "# NeroNet-Console: https://console.darknero.com/me\n" +
        "# NeroNet-Device: dev-0123abcd\n" +
        "[Interface]\nPrivateKey = ${fakeKey(1)}\nAddress = 100.64.12.34/32\n" +
        "[Peer]\nPublicKey = ${fakeKey(50)}\nEndpoint = gateway.example:51820\n" +
        "AllowedIPs = 100.64.0.0/10\nPersistentKeepalive = 25\n"

    @Test
    fun findsAnEntryByDevicePublicKey() {
        val store = ProfileStore(folder.root)
        val id = store.add(text)
        val key = NeroNetProfile.parse(text).devicePublicKey
        assertEquals(id, store.findByPublicKey(key)?.id)
    }

    @Test
    fun unknownDevicePublicKeyFindsNothing() {
        val store = ProfileStore(folder.root)
        store.add(text)
        assertNull(store.findByPublicKey(fakeKey(200)))
    }
}
