package com.darknero.neronet.ui.profiles

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.ImportResult
import com.darknero.neronet.R
import com.darknero.neronet.ui.theme.NeroNetTheme
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PasteProfileScreenTest {
    @get:Rule val rule = createAndroidComposeRule<ComponentActivity>()

    private val profileText = "[Interface]\nPrivateKey = test\n[Peer]\nPublicKey = test\n"

    @Test
    fun windowIsSecureWhileShown() {
        rule.setContent {
            NeroNetTheme { PasteProfileScreen(result = null, onImport = {}, onBack = {}) }
        }

        rule.runOnIdle {
            val flags = rule.activity.window.attributes.flags
            assertTrue((flags and WindowManager.LayoutParams.FLAG_SECURE) != 0)
        }
    }

    @Test
    fun importDisabledWhenBlank() {
        rule.setContent {
            NeroNetTheme { PasteProfileScreen(result = null, onImport = {}, onBack = {}) }
        }

        rule.onNodeWithText("Import").assertIsNotEnabled()
        rule.onNodeWithTag("paste_field").performTextInput("x")
        rule.onNodeWithText("Import").assertIsEnabled()
    }

    @Test
    fun invalidResultShowsReasonUnderField() {
        rule.setContent {
            NeroNetTheme {
                PasteProfileScreen(
                    result = ImportResult.Invalid(R.string.reason_refused_setting),
                    onImport = {},
                    onBack = {},
                )
            }
        }

        rule.onNodeWithText("This profile cannot be used:", substring = true).assertExists()
    }

    @Test
    fun clipboardClearedAfterPasteImport() {
        val clipboard = rule.activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("NeroNet", profileText))
        var result by mutableStateOf<ImportResult?>(null)
        rule.setContent {
            NeroNetTheme { PasteProfileScreen(result = result, onImport = {}, onBack = {}) }
        }

        rule.onNodeWithTag("paste_field").performTextInput(profileText)
        rule.onNodeWithText("Import").performClick()
        rule.runOnIdle { result = ImportResult.Imported("p1") }
        rule.waitForIdle()

        assertFalse(clipboard.hasPrimaryClip())
    }
}
