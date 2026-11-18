package com.darknero.neronet.ui.theme

import android.content.Context
import android.provider.Settings
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.ui.map.reducedMotion
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class BrandMarkAnimationTest {
    @get:Rule val rule = createComposeRule()

    @Test
    fun playsOnceAndReportsDoneAtTheEnd() {
        var done = 0
        rule.mainClock.autoAdvance = false
        rule.setContent { NeroNetTheme { BrandMark(animate = true, onDone = { done++ }, reducedMotion = false) } }
        rule.mainClock.advanceTimeBy(AllaccioTimeline.TOTAL_MS / 2L)
        assertEquals(0, done)
        rule.mainClock.advanceTimeBy(AllaccioTimeline.TOTAL_MS.toLong())
        rule.waitForIdle()
        assertEquals(1, done)
        rule.mainClock.advanceTimeBy(5_000)
        assertEquals("never loops", 1, done)
    }

    @Test
    fun reducedMotionSkipsStraightToTheFinalState() {
        var done = 0
        rule.mainClock.autoAdvance = false
        rule.setContent { NeroNetTheme { BrandMark(animate = true, onDone = { done++ }, reducedMotion = true) } }
        rule.mainClock.advanceTimeBy(50)
        rule.waitForIdle()
        assertEquals("done at once, no 1.9 s wait", 1, done)
    }

    @Test
    fun systemAnimationsOffMeansReducedMotion() {
        val resolver = ApplicationProvider.getApplicationContext<Context>().contentResolver
        Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
        assertTrue(reducedMotion(resolver))
        Settings.Global.putFloat(resolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f)
        assertFalse(reducedMotion(resolver))
    }
}
