package com.darknero.neronet.tunnel

import org.junit.Assert.assertEquals
import org.junit.Test

class LinkHealthTest {

    @Test
    fun freshHandshakeIsOk() {
        assertEquals(LinkHealth.OK, linkHealth(connectedForMs = 60_000, handshakeAgeMs = 180_000, keepaliveOn = true))
    }

    @Test
    fun oldHandshakeIsStale() {
        assertEquals(LinkHealth.STALE, linkHealth(connectedForMs = 60_000, handshakeAgeMs = 180_001, keepaliveOn = true))
    }

    @Test
    fun noHandshakeWithinGraceIsWaiting() {
        assertEquals(LinkHealth.WAITING, linkHealth(connectedForMs = 15_000, handshakeAgeMs = null, keepaliveOn = true))
    }

    @Test
    fun noHandshakeAfterGraceIsStale() {
        assertEquals(LinkHealth.STALE, linkHealth(connectedForMs = 15_001, handshakeAgeMs = null, keepaliveOn = true))
    }

    @Test
    fun keepaliveOffNeverGoesStaleAfterFirstHandshake() {
        assertEquals(LinkHealth.OK, linkHealth(connectedForMs = 3_600_000, handshakeAgeMs = 3_600_000, keepaliveOn = false))
    }
}
