package com.darknero.neronet.ui.profiles

import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.PeerSummary
import com.darknero.neronet.ProfileSummary
import com.darknero.neronet.ui.theme.NeroNetTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProfileOptionsScreenTest {
    @get:Rule val rule = createComposeRule()

    private val profile = ProfileSummary(
        id = "p1",
        title = "example.com",
        deviceId = null,
        addresses = listOf("100.64.12.34"),
        dns = emptyList(),
        consoleUrl = "https://console.example.com",
        peers = listOf(PeerSummary("PEER1", "gw.example.com", 51820, listOf("0.0.0.0/0"), 25)),
        devicePublicKey = "DEV1",
    )

    @Test
    fun killSwitchRowShowsItsStateInWordsAndToggles() {
        var changed: Boolean? = null
        rule.setContent {
            NeroNetTheme {
                ProfileOptionsScreen(
                    profile = profile,
                    killSwitch = true,
                    onKillSwitchChange = { changed = it },
                    onBack = {},
                )
            }
        }

        rule.onNodeWithText("Kill switch").assertExists()
        rule.onNodeWithText("On").assertExists()
        rule.onNodeWithTag("option_kill_switch").assertIsOn().assertHasClickAction().assertHeightIsAtLeast(48.dp)
        rule.onNodeWithTag("option_kill_switch").performClick()
        assertEquals(false, changed)
    }

    @Test
    fun offStateIsWrittenOut() {
        rule.setContent {
            NeroNetTheme {
                ProfileOptionsScreen(profile = profile, killSwitch = false, onKillSwitchChange = {}, onBack = {})
            }
        }

        rule.onNodeWithText("Off").assertExists()
        rule.onNodeWithTag("option_kill_switch").assertIsOff()
    }
}
