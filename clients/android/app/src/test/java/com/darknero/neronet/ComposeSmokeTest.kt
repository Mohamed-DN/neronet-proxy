package com.darknero.neronet

import androidx.compose.material3.Text
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ComposeSmokeTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun composeRendersText() {
        rule.setContent { Text("NeroNet") }
        rule.onNodeWithText("NeroNet").assertExists()
    }
}
