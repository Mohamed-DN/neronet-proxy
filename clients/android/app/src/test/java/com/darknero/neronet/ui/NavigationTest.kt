package com.darknero.neronet.ui

import androidx.compose.runtime.saveable.SaverScope
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NavigationTest {

    @Test
    fun popAtHomeReturnsFalse() {
        val nav = NavState()

        assertFalse(nav.pop())
        assertEquals(Route.HOME, nav.current)
    }

    @Test
    fun pushPopOrder() {
        val nav = NavState()
        nav.push(Route.PROFILES)
        nav.push(Route.ADD_PROFILE)
        nav.push(Route.PASTE_PROFILE)

        assertEquals(Route.PASTE_PROFILE, nav.current)
        assertTrue(nav.pop())
        assertEquals(Route.ADD_PROFILE, nav.current)
        assertTrue(nav.pop())
        assertEquals(Route.PROFILES, nav.current)
        assertTrue(nav.pop())
        assertEquals(Route.HOME, nav.current)
    }

    @Test
    fun popToHomeClears() {
        val nav = NavState()
        nav.push(Route.PROFILES)
        nav.push(Route.ADD_PROFILE)
        nav.push(Route.PASTE_PROFILE)

        nav.popTo(Route.HOME)

        assertEquals(Route.HOME, nav.current)
        assertFalse(nav.pop())
    }

    @Test
    fun saverRoundTrips() {
        val nav = NavState()
        nav.push(Route.SETTINGS)
        nav.push(Route.LICENSES)

        val saved = with(NavState.Saver) { SaverScope { true }.save(nav) }
        val restored = NavState.Saver.restore(saved!!)!!

        assertEquals(Route.LICENSES, restored.current)
        assertTrue(restored.pop())
        assertEquals(Route.SETTINGS, restored.current)
    }
}
