package com.darknero.neronet.ui.apps

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.tunnel.AppRuleMode
import com.darknero.neronet.tunnel.AppRules
import com.darknero.neronet.ui.theme.NeroNetTheme
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

private val apps = listOf(
    AppEntry("org.example.bank", "Bank"),
    AppEntry("org.example.mail", "Mail"),
    AppEntry("org.example.video", "Video player"),
)

class AppPickerModelTest {

    @Test
    fun blankQueryKeepsEveryApp() {
        assertEquals(apps, filterApps(apps, ""))
        assertEquals(apps, filterApps(apps, "   "))
    }

    @Test
    fun searchMatchesLabelOrPackageIgnoringCase() {
        assertEquals(listOf(apps[2]), filterApps(apps, "VIDEO"))
        assertEquals(listOf(apps[1]), filterApps(apps, "example.mail"))
        assertEquals(emptyList<AppEntry>(), filterApps(apps, "zzz"))
    }

    @Test
    fun toggleAddsThenRemoves() {
        val once = toggled(AppRules(AppRuleMode.EXCLUDE), "org.example.bank")
        assertEquals(setOf("org.example.bank"), once.packages)
        assertEquals(emptySet<String>(), toggled(once, "org.example.bank").packages)
        assertEquals(AppRuleMode.EXCLUDE, once.mode)
    }

    @Test
    fun summaryNamesTheModeAndTheCount() {
        assertEquals(RulesSummary.AllApps, summaryOf(AppRules.NONE))
        assertEquals(RulesSummary.AllApps, summaryOf(AppRules(AppRuleMode.INCLUDE_ONLY, emptySet())))
        assertEquals(RulesSummary.AllApps, summaryOf(AppRules(AppRuleMode.ALL, setOf("a"))))
        assertEquals(RulesSummary.IncludeOnly(2), summaryOf(AppRules(AppRuleMode.INCLUDE_ONLY, setOf("a", "b"))))
        assertEquals(RulesSummary.Exclude(1), summaryOf(AppRules(AppRuleMode.EXCLUDE, setOf("a"))))
    }
}

@RunWith(AndroidJUnit4::class)
class AppPickerScreenTest {
    @get:Rule val rule = createComposeRule()


    private var latest by mutableStateOf(AppRules(AppRuleMode.EXCLUDE, setOf("org.example.mail")))
    private fun show(initial: AppRules, loaded: List<AppEntry>? = apps) {
        latest = initial
        rule.setContent {
            NeroNetTheme {
                AppPickerScreen(
                    apps = loaded,
                    rules = latest,
                    onRulesChange = { latest = it },
                    onBack = {},
                )
            }
        }
    }

    @Test
    fun listShowsCheckedStateAndRowsAreTouchable() {
        show(AppRules(AppRuleMode.EXCLUDE, setOf("org.example.mail")))

        rule.onNodeWithTag("app_row_org.example.mail").assertIsOn().assertHeightIsAtLeast(48.dp)
        rule.onNodeWithTag("app_row_org.example.bank").assertIsOff()
    }

    @Test
    fun tappingARowChangesTheList() {
        show(AppRules(AppRuleMode.EXCLUDE, emptySet()))

        rule.onNodeWithTag("app_row_org.example.bank").performClick()

        assertEquals(setOf("org.example.bank"), latest.packages)
    }

    @Test
    fun searchNarrowsTheList() {
        show(AppRules(AppRuleMode.INCLUDE_ONLY, emptySet()))

        rule.onNodeWithTag("split_search").performTextInput("vid")

        rule.onNodeWithTag("app_row_org.example.video").assertExists()
        rule.onNodeWithTag("app_row_org.example.bank").assertDoesNotExist()
    }

    @Test
    fun searchWithNoMatchSaysSo() {
        show(AppRules(AppRuleMode.INCLUDE_ONLY, emptySet()))

        rule.onNodeWithTag("split_search").performTextInput("zzz")

        rule.onNodeWithTag("split_no_match").assertExists()
    }

    @Test
    fun allAppsModeHidesTheList() {
        show(AppRules.NONE)

        rule.onNodeWithTag("split_mode_all").assertIsSelected()
        rule.onNodeWithTag("split_search").assertDoesNotExist()
    }

    @Test
    fun choosingAModeKeepsTheList() {
        show(AppRules(AppRuleMode.EXCLUDE, setOf("org.example.mail")))

        rule.onNodeWithTag("split_mode_include").performClick()

        assertEquals(AppRules(AppRuleMode.INCLUDE_ONLY, setOf("org.example.mail")), latest)
    }
}
