package com.darknero.neronet.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.AddMethod
import com.darknero.neronet.PeerSummary
import com.darknero.neronet.ProfileSummary
import com.darknero.neronet.tunnel.MachineState
import com.darknero.neronet.tunnel.TunnelError
import com.darknero.neronet.tunnel.TunnelPhase
import com.darknero.neronet.tunnel.TunnelStats
import com.darknero.neronet.ui.LayoutMode
import com.darknero.neronet.ui.theme.NeroNetTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
class HomeScreenTest {
    @get:Rule val rule = createComposeRule()

    private val now = 1_000_000_000L
    private val wall = 1_700_000_000_000L

    private val profile = ProfileSummary(
        id = "p1",
        title = "darknero.com",
        deviceId = "laptop-7",
        addresses = listOf("100.64.12.34"),
        dns = listOf("100.64.0.53"),
        consoleUrl = "https://console.darknero.com",
        peers = listOf(
            PeerSummary(
                publicKey = "PEERKEY",
                endpointHost = "gw.darknero.com",
                endpointPort = 51820,
                allowedIps = listOf("100.64.0.0/10"),
                keepaliveSeconds = 25,
            ),
        ),
        devicePublicKey = "DEVKEY",
    )

    /** Handshake 10 s old: the gateway answers, so the link is OK. */
    private val freshStats = TunnelStats(
        rxBytes = 4_096,
        txBytes = 1_024,
        lastHandshakeWallMs = mapOf("PEERKEY" to (wall - 10_000)),
    )

    private fun state(
        phase: TunnelPhase,
        hasProfiles: Boolean = true,
        summary: ProfileSummary? = profile,
        stats: TunnelStats? = freshStats,
    ): HomeUiState = buildHomeUiState(
        machine = MachineState(phase, wantConnected = phase !is TunnelPhase.Disconnected),
        profile = summary,
        hasProfiles = hasProfiles,
        stats = stats,
        nowElapsedMs = now,
        nowWallMs = wall,
    )

    private val connectedTwelveMinutes = TunnelPhase.Connected("p1", now - 12 * 60_000L)

    private fun setHome(
        state: HomeUiState,
        layout: LayoutMode = LayoutMode.SINGLE,
        onAdd: (AddMethod) -> Unit = {},
        onErrorAction: (ErrorAction) -> Unit = {},
        secondaryPane: @Composable () -> Unit = {},
    ) {
        rule.setContent {
            NeroNetTheme {
                HomeScreen(
                    state = state,
                    layout = layout,
                    onToggle = {},
                    onCancel = {},
                    onErrorAction = onErrorAction,
                    onDismissError = {},
                    onOpenConsole = {},
                    onCopyAddress = {},
                    onAdd = onAdd,
                    onProfiles = {},
                    onSettings = {},
                    secondaryPane = secondaryPane,
                )
            }
        }
    }

    private fun statusText(): String =
        rule.onNodeWithTag("status").fetchSemanticsNode().config[SemanticsProperties.Text].joinToString(" ") { it.text }

    @Test
    fun statusIsAPoliteLiveRegion() {
        setHome(state(connectedTwelveMinutes))

        rule.onNodeWithTag("status")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Polite))
        val text = statusText()
        assertTrue(text, text.contains("Protected"))
        assertTrue(text, text.contains("Connected to darknero.com"))
    }

    @Test
    fun elapsedIsOutsideTheLiveRegion() {
        setHome(state(connectedTwelveMinutes))

        rule.onNodeWithText("for 12 minutes").assertExists()
        assertTrue(!statusText().contains("for 12 minutes"))
    }

    @Test
    fun cancelNotShownBeforeTwoSeconds() {
        setHome(state(TunnelPhase.Connecting("p1", now - 500)))

        rule.onAllNodesWithText("Cancel").assertCountEquals(0)
    }

    @Test
    fun cancelShownAfterTheFirstTwoSeconds() {
        setHome(state(TunnelPhase.Connecting("p1", now - 5_000)))

        rule.onNodeWithText("Cancel").assertHasClickAction()
    }

    @Test
    fun errorIsAssertiveWithAction() {
        var chosen: ErrorAction? = null
        setHome(state(TunnelPhase.Error(TunnelError.UNABLE_TO_START_VPN, "p1")), onErrorAction = { chosen = it })

        rule.onNodeWithTag("status_error")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.LiveRegion, LiveRegionMode.Assertive))
        rule.onNodeWithText("Open VPN settings").performClick()
        assertEquals(ErrorAction.OPEN_VPN_SETTINGS, chosen)
    }

    @Test
    fun emptyStateOffersThreeWays() {
        var chosen: AddMethod? = null
        setHome(state(TunnelPhase.Disconnected, hasProfiles = false, summary = null), onAdd = { chosen = it })

        rule.onNodeWithText("Scan the QR code").assertHasClickAction()
        rule.onNodeWithText("Import a file").assertHasClickAction()
        rule.onNodeWithText("Paste the text").assertHasClickAction()
        rule.onNodeWithText("Scan the QR code").performClick()
        assertEquals(AddMethod.QR, chosen)
    }

    @Test
    fun detailsToggleExpands() {
        setHome(state(connectedTwelveMinutes))

        rule.onAllNodesWithText("Reachable network").assertCountEquals(0)
        rule.onNodeWithText("Show details").performClick()
        rule.onNodeWithText("Hide details").assertExists()
        rule.onNodeWithText("Reachable network").assertExists()
    }

    @Test
    @Config(qualifiers = "w1280dp-h800dp-land")
    fun twoPaneShowsSecondaryPane() {
        setHome(
            state(connectedTwelveMinutes),
            layout = LayoutMode.TWO_PANE,
            secondaryPane = { Box(Modifier.testTag("secondary_pane")) { Text("Profiles") } },
        )

        rule.onNodeWithTag("secondary_pane").assertExists()
        rule.onAllNodesWithContentDescription("Change profile", substring = true).assertCountEquals(0)
    }

    @Test
    @Config(qualifiers = "it")
    fun italianCopyRenders() {
        setHome(state(connectedTwelveMinutes))

        rule.onNodeWithText("Protetto").assertExists()
    }
}
