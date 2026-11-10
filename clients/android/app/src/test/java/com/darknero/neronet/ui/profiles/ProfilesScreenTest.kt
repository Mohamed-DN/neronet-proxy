package com.darknero.neronet.ui.profiles

import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsNotSelected
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.PeerSummary
import com.darknero.neronet.ProfileSummary
import com.darknero.neronet.ui.theme.NeroNetTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ProfilesScreenTest {
    @get:Rule val rule = createComposeRule()

    private val office = ProfileSummary(
        id = "p1",
        title = "darknero.com",
        deviceId = "dev-0123abcd",
        addresses = listOf("100.64.12.34"),
        dns = emptyList(),
        consoleUrl = "https://console.darknero.com",
        peers = listOf(PeerSummary("PEER1", "gw.darknero.com", 51820, listOf("100.64.0.0/10"), 25)),
        devicePublicKey = "DEV1",
    )

    private val lab = office.copy(
        id = "p2",
        title = "lab.example",
        deviceId = null,
        addresses = listOf("100.64.20.7"),
        consoleUrl = null,
    )

    private fun setScreen(
        selectedId: String? = "p1",
        activeId: String? = null,
        onSelect: (String) -> Unit = {},
        onDelete: (String) -> Unit = {},
    ) {
        rule.setContent {
            NeroNetTheme {
                ProfilesScreen(
                    profiles = listOf(office, lab),
                    selectedId = selectedId,
                    activeId = activeId,
                    onSelect = onSelect,
                    onDelete = onDelete,
                    onAdd = {},
                    onBack = null,
                )
            }
        }
    }

    private fun openDeleteFor(title: String) {
        rule.onNodeWithContentDescription("More options for $title").performClick()
        rule.onNodeWithText("Delete").performClick()
    }

    @Test
    fun rowsAreRadioButtonsAndActiveSaysInUse() {
        setScreen(selectedId = "p1", activeId = "p1")

        rule.onNodeWithTag("profile_row_p1")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton))
            .assertIsSelected()
        rule.onNodeWithTag("profile_row_p2")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton))
            .assertIsNotSelected()
        rule.onAllNodesWithText("In use").assertCountEquals(1)
    }

    @Test
    fun deleteAsksForConfirmation() {
        var deleted: String? = null
        setScreen(onDelete = { deleted = it })

        openDeleteFor("darknero.com")
        rule.onNodeWithText("Delete darknero.com?").assertExists()
        rule.onNodeWithTag("delete_confirm").performClick()

        assertEquals("p1", deleted)
    }

    @Test
    fun cancelKeepsTheProfile() {
        var deleted: String? = null
        setScreen(onDelete = { deleted = it })

        openDeleteFor("darknero.com")
        rule.onNodeWithText("Cancel").performClick()

        assertNull(deleted)
    }

    @Test
    fun connectedDeleteWarnsTheConnectionCloses() {
        setScreen(activeId = "p1")

        openDeleteFor("darknero.com")
        rule.onNodeWithText("The connection closes first.", substring = true).assertExists()
    }
}
