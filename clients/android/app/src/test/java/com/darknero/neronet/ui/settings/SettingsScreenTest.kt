package com.darknero.neronet.ui.settings

import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.R
import com.darknero.neronet.ThemeMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SettingsScreenTest {

    @get:Rule
    val rule = createComposeRule()

    private val context = ApplicationProvider.getApplicationContext<android.content.Context>()

    private fun show(
        theme: ThemeMode = ThemeMode.SYSTEM,
        onThemeChange: (ThemeMode) -> Unit = {},
        openVpn: () -> Boolean = { true },
        onOpenLicenses: () -> Unit = {},
    ) {
        rule.setContent {
            SettingsScreen(
                themeMode = theme,
                onThemeChange = onThemeChange,
                onOpenVpnSettings = openVpn,
                onOpenLicenses = onOpenLicenses,
                versionName = "0.1.0",
                versionCode = 1,
                onBack = {},
            )
        }
    }

    @Test
    fun themeRowsAreRadioButtons() {
        show(theme = ThemeMode.SYSTEM)

        rule.onAllNodes(radio()).assertCountEquals(3)
        rule.onNode(hasText(context.getString(R.string.theme_system)) and radio())
            .assertIsSelected()
    }

    @Test
    fun choosingDarkCallsBack() {
        var chosen: ThemeMode? = null
        show(onThemeChange = { chosen = it })

        rule.onNode(hasText(context.getString(R.string.theme_dark)) and radio()).performClick()

        assertEquals(ThemeMode.DARK, chosen)
    }

    @Test
    fun vpnButtonCallsBack() {
        var opened = false
        show(openVpn = {
            opened = true
            true
        })

        rule.onNodeWithText(context.getString(R.string.action_open_vpn_settings)).performClick()

        assertTrue(opened)
    }

    @Test
    fun licencesOpenFromAbout() {
        var opened = false
        show(onOpenLicenses = { opened = true })

        rule.onNodeWithText(context.getString(R.string.settings_licenses)).performScrollTo().performClick()

        assertTrue(opened)
    }
}

private fun radio(): SemanticsMatcher = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)
