package com.darknero.neronet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NeroDropTest {

    @Test
    fun usesTheConsoleOrigin() {
        assertEquals("https://console.example.com/drop", NeroDrop.url("https://console.example.com"))
        assertEquals("https://console.example.com/drop", NeroDrop.url("https://console.example.com/"))
    }

    @Test
    fun dropsPathQueryAndFragmentOfTheConsoleUrl() {
        assertEquals("https://console.example.com/drop", NeroDrop.url("https://console.example.com/me/devices?x=1#frag"))
    }

    @Test
    fun keepsAnExplicitPort() {
        assertEquals("https://console.example.com:8443/drop", NeroDrop.url("https://console.example.com:8443/me"))
    }

    @Test
    fun neverAddsAFragmentOrAKey() {
        val url = NeroDrop.url("https://console.example.com/#secret")!!
        assertEquals(-1, url.indexOf('#'))
        assertEquals(-1, url.indexOf('?'))
    }

    @Test
    fun noUrlWithoutAnHttpsConsole() {
        assertNull(NeroDrop.url(null))
        assertNull(NeroDrop.url(""))
        assertNull(NeroDrop.url("http://console.example.com"))
        assertNull(NeroDrop.url("console.example.com"))
        assertNull(NeroDrop.url("https://"))
        assertNull(NeroDrop.url("javascript:alert(1)"))
    }
}
