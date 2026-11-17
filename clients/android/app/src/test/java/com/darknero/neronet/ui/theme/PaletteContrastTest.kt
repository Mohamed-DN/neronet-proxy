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
            for ((role, color) in listOf("ink" to p.ink, "inkMuted" to p.inkMuted, "progress" to p.progress,
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
    fun brandTokensArePinned() {
        val l = NnPalettes.Light
        val d = NnPalettes.Dark
        assertEquals(Color(0xFF15232D), l.ink)
        assertEquals(Color(0xFFF2F4F3), l.surface)
        assertEquals(Color(0xFFFFFFFF), l.relief)
        assertEquals(Color(0xFFE8EEF0), d.ink)
        assertEquals(Color(0xFF0E1A22), d.surface)
        assertEquals(Color(0xFF16252F), d.relief)
        assertEquals(Color(0xFFF5C211), l.signal)
        assertEquals(Color(0xFFF5C211), d.signal)
        assertEquals(Color(0xFF126E34), l.connected)
        assertEquals(Color(0xFF4ADE80), d.connected)
        assertEquals(Color(0xFFB71C1C), l.alarm)
        assertEquals(Color(0xFFF87171), d.alarm)
    }

    @Test
    fun signalIsNeverTextOnlyAFillWithInkOnIt() {
        // The yellow is 1.5:1 on the light sheet, so it is a fill and a focus band, not a text colour.
        assertContrast("Light ink on signal", NnPalettes.Light.onSignal, NnPalettes.Light.signal, 4.5)
        assertContrast("Dark ink on signal", NnPalettes.Dark.onSignal, NnPalettes.Dark.signal, 4.5)
    }
}
