package com.darknero.neronet.ui.theme

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.max
import kotlin.math.min

class PaletteContrastTest {

    private fun contrast(a: Color, b: Color): Double {
        val la = a.luminance().toDouble()
        val lb = b.luminance().toDouble()
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    private fun assertContrast(label: String, fg: Color, bg: Color, minimum: Double) {
        val ratio = contrast(fg, bg)
        assertTrue("$label: contrast ${"%.2f".format(ratio)} is below $minimum", ratio >= minimum)
    }

    private val palettes = listOf("Light" to NnPalettes.Light, "Dark" to NnPalettes.Dark)

    @Test
    fun textRolesReachAaOnSurfaceAndRelief() {
        for ((name, p) in palettes) {
            for ((role, color) in listOf("ink" to p.ink, "inkMuted" to p.inkMuted, "signal" to p.signal,
                "connected" to p.connected, "alarm" to p.alarm)) {
                assertContrast("$name $role on surface", color, p.surface, 4.5)
                assertContrast("$name $role on relief", color, p.relief, 4.5)
            }
        }
    }

    @Test
    fun outlineReachesNonTextContrastOnSurfaceAndRelief() {
        for ((name, p) in palettes) {
            assertContrast("$name outline on surface", p.outline, p.surface, 3.0)
            assertContrast("$name outline on relief", p.outline, p.relief, 3.0)
        }
    }

    @Test
    fun onColoursReachAaOnTheirFill() {
        for ((name, p) in palettes) {
            assertContrast("$name onSignal on signal", p.onSignal, p.signal, 4.5)
            assertContrast("$name onConnected on connected", p.onConnected, p.connected, 4.5)
            assertContrast("$name onAlarm on alarm", p.onAlarm, p.alarm, 4.5)
        }
    }

    @Test
    fun connectedTokensArePinned() {
        assertEquals(Color(0xFF15803D), NnPalettes.Light.connected)
        assertEquals(Color(0xFF4ADE80), NnPalettes.Dark.connected)
    }
}
