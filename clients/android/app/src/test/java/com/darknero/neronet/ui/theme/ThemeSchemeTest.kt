package com.darknero.neronet.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** The Material 3 scheme follows the brand tokens: ink primary, signal only as tertiary, danger as error. */
@RunWith(AndroidJUnit4::class)
class ThemeSchemeTest {

    @get:Rule
    val compose = createComposeRule()

    private fun schemeOf(dark: Boolean): androidx.compose.material3.ColorScheme {
        var scheme: androidx.compose.material3.ColorScheme? = null
        compose.setContent {
            NeroNetTheme(darkTheme = dark) {
                scheme = MaterialTheme.colorScheme
                Text("x")
            }
        }
        compose.waitForIdle()
        return scheme!!
    }

    private fun check(dark: Boolean, p: NnPalette) {
        val s = schemeOf(dark)
        assertEquals(p.ink, s.primary)
        assertEquals(p.surface, s.onPrimary)
        assertEquals(p.surface, s.background)
        assertEquals(p.relief, s.surfaceContainer)
        assertEquals(p.signal, s.tertiary)
        assertEquals(Color(0xFFF5C211), s.tertiary)
        assertEquals(p.alarm, s.error)
    }

    @Test
    fun lightSchemeUsesBrandTokens() = check(false, NnPalettes.Light)

    @Test
    fun darkSchemeUsesBrandTokens() = check(true, NnPalettes.Dark)
}
