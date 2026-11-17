package com.darknero.neronet.ui.home

import androidx.compose.ui.test.assertHasClickAction
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.ui.theme.NeroNetTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DetailsPanelDropTest {
    @get:Rule val rule = createComposeRule()

    private fun show(dropUrl: String?, onOpenDrop: (String) -> Unit = {}) {
        rule.setContent {
            NeroNetTheme {
                DetailsPanel(
                    rows = emptyList(),
                    consoleUrl = "https://console.example.com",
                    expanded = true,
                    onExpandedChange = {},
                    alwaysExpanded = true,
                    onCopyAddress = {},
                    onOpenConsole = {},
                    dropUrl = dropUrl,
                    onOpenDrop = onOpenDrop,
                )
            }
        }
    }

    @Test
    fun dropButtonOpensTheDropUrlAndIsATextLabelledTarget() {
        var opened: String? = null
        show("https://console.example.com/drop") { opened = it }

        rule.onNodeWithText("Send a file with NeroDrop").assertHasClickAction().assertHeightIsAtLeast(48.dp)
        rule.onNodeWithText("Send a file with NeroDrop").performClick()

        assertEquals("https://console.example.com/drop", opened)
    }

    @Test
    fun dropButtonIsHiddenWithoutAUrl() {
        show(null)

        rule.onNodeWithText("Send a file with NeroDrop").assertDoesNotExist()
    }
}
