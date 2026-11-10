package com.darknero.neronet

import android.app.Application
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowVpnService
import java.util.Base64

@RunWith(AndroidJUnit4::class)
class MainActivityTest {
    @get:Rule val rule = createAndroidComposeRule<MainActivity>()

    private val app: TestNeroNetApplication
        get() = NeroNetApplication.from(ApplicationProvider.getApplicationContext<Application>()) as TestNeroNetApplication

    // Fake 32-byte keys for these tests only; they protect nothing.
    private fun fakeKey(seed: Int): String =
        Base64.getEncoder().encodeToString(ByteArray(32) { (seed + it).toByte() })

    private fun profileText(seed: Int): String =
        "# NeroNet-Profile: 1\n" +
            "[Interface]\nPrivateKey = ${fakeKey(seed)}\nAddress = 100.64.12.34/32\n" +
            "[Peer]\nPublicKey = ${fakeKey(seed + 100)}\nEndpoint = gateway.example:51820\nAllowedIPs = 100.64.0.0/10\n"

    /** The activity is already running; the profile is added afterwards, and the screens follow the repository. */
    private fun storeProfile() {
        val id = app.profiles.add(profileText(90))
        app.profiles.select(id)
    }

    @Test
    fun emptyInstallShowsOnboarding() {
        rule.onNodeWithText("Add this device").assertExists()
        rule.onNodeWithText("Scan the QR code").assertExists()
    }

    @Test
    fun settingsOpensAndBackReturns() {
        rule.onNodeWithContentDescription("Settings").performClick()
        rule.onNodeWithText("Theme").assertExists()

        rule.runOnUiThread { rule.activity.onBackPressedDispatcher.onBackPressed() }
        rule.waitForIdle()
        rule.onNodeWithText("Add this device").assertExists()
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-land")
    fun tabletLandscapeShowsProfilesPane() {
        storeProfile()
        rule.waitForIdle()

        rule.onNodeWithText("Profiles").assertExists()
        rule.onNodeWithTag("map_device").assertExists()
    }

    @Test
    fun connectingSurvivesRotation() {
        storeProfile()
        app.fakeEngine.upDelayMs = 60_000
        ShadowVpnService.setPrepareResult(null)
        rule.waitForIdle()

        rule.onNodeWithTag("map_device").performClick()
        rule.waitForIdle()
        rule.onNodeWithText("Connecting").assertExists()

        rule.activityRule.scenario.recreate()
        rule.waitForIdle()
        rule.onNodeWithText("Connecting").assertExists()
    }
}
