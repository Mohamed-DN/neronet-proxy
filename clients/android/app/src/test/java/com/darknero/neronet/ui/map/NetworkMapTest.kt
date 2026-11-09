package com.darknero.neronet.ui.map

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.ui.theme.NeroNetTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NetworkMapTest {
    @get:Rule val rule = createComposeRule()

    private val picture = "Network map: this device, the gateway gw.darknero.com and your organisation's network 100.64.0.0/10."

    private fun setMap(
        state: MapState = MapState.PROTECTED,
        topology: MapTopology = MapTopology.Gateway(fullTunnel = false),
        switchOn: Boolean = true,
        switchEnabled: Boolean = true,
        onToggle: (Boolean) -> Unit = {},
    ) {
        rule.setContent {
            NeroNetTheme {
                Box(Modifier.size(240.dp)) {
                    NetworkMap(
                        state = state,
                        topology = topology,
                        peerResponded = listOf(true),
                        pictureDescription = picture,
                        switchLabel = "Connection to darknero.com",
                        stateDescription = "Protected",
                        switchOn = switchOn,
                        switchEnabled = switchEnabled,
                        onToggle = onToggle,
                        deviceLabel = "This device",
                        gatewayLabel = "gw.example",
                        networkLabel = "Your organisation",
                        networkCaption = "100.64.0.0/10",
                        overflowLabel = null,
                        reducedMotion = true,
                    )
                }
            }
        }
    }

    @Test
    fun deviceIsASwitchWithStateDescription() {
        setMap()

        rule.onNodeWithTag("map_device")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.Switch))
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Protected"))
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf("Connection to darknero.com")))
            .assertIsOn()
    }

    @Test
    fun clickTogglesOff() {
        var toggled: Boolean? = null
        setMap(switchOn = true, onToggle = { toggled = it })

        rule.onNodeWithTag("map_device").performClick()

        assertEquals(false, toggled)
    }

    @Test
    fun disabledSwitchDoesNotToggle() {
        var toggled: Boolean? = null
        setMap(switchOn = true, switchEnabled = false, onToggle = { toggled = it })

        rule.onNodeWithTag("map_device").assertIsNotEnabled().performClick()

        assertNull(toggled)
    }

    @Test
    fun touchTargetIsAtLeast48dp() {
        setMap()

        val bounds = rule.onNodeWithTag("map_device").fetchSemanticsNode().boundsInRoot
        val minPx = with(rule.density) { 48.dp.toPx() }
        assertTrue("touch target ${bounds.width}px wide, need at least $minPx", bounds.width >= minPx)
        assertTrue("touch target ${bounds.height}px high, need at least $minPx", bounds.height >= minPx)
    }

    @Test
    fun pictureHasTopologyDescription() {
        setMap()

        rule.onNodeWithTag("map_picture")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.ContentDescription, listOf(picture)))
    }

    @Test
    fun labelsAreHiddenFromTalkBack() {
        setMap()

        rule.onAllNodesWithText("gw.example").assertCountEquals(0)
        rule.onNodeWithTag("map_label_gateway").assertExists()
    }

    @Test
    fun labelsDropAtLargeFontScale() {
        rule.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale = 1.5f)) {
                NeroNetTheme {
                    Box(Modifier.size(240.dp)) {
                        NetworkMap(
                            state = MapState.PROTECTED,
                            topology = MapTopology.Gateway(fullTunnel = false),
                            peerResponded = listOf(true),
                            pictureDescription = picture,
                            switchLabel = "Connection to darknero.com",
                            stateDescription = "Protected",
                            switchOn = true,
                            switchEnabled = true,
                            onToggle = {},
                            deviceLabel = "This device",
                            gatewayLabel = "gw.example",
                            networkLabel = "Your organisation",
                            networkCaption = "100.64.0.0/10",
                            overflowLabel = null,
                            reducedMotion = true,
                        )
                    }
                }
            }
        }

        rule.onNodeWithTag("map_label_gateway").assertDoesNotExist()
    }

    @Test
    fun rendersEveryStateAndTopology() {
        val cases = MapState.entries.flatMap { state ->
            listOf(
                state to MapTopology.DeviceOnly,
                state to MapTopology.Gateway(fullTunnel = false),
                state to MapTopology.Gateway(fullTunnel = true),
                state to MapTopology.Servers(count = 3),
                state to MapTopology.Servers(count = 9),
            )
        }
        var index by mutableIntStateOf(0)
        rule.setContent {
            val (state, topology) = cases[index]
            NeroNetTheme {
                Box(Modifier.size(240.dp)) {
                    NetworkMap(
                        state = state,
                        topology = topology,
                        peerResponded = List(9) { it % 2 == 0 },
                        pictureDescription = picture,
                        switchLabel = "Connection to darknero.com",
                        stateDescription = state.name,
                        switchOn = true,
                        switchEnabled = true,
                        onToggle = {},
                        deviceLabel = "This device",
                        gatewayLabel = "gw.example",
                        networkLabel = "Your organisation",
                        networkCaption = "100.64.0.0/10",
                        overflowLabel = "+4",
                        reducedMotion = true,
                    )
                }
            }
        }
        for (i in cases.indices) {
            rule.runOnIdle { index = i }
            rule.waitForIdle()
            rule.onNodeWithTag("map_picture").assertExists()
        }
    }
}
