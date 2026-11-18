package com.darknero.neronet.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AllaccioTimelineTest {
    @Test
    fun startsEmptyAndEndsAtRest() {
        val first = AllaccioTimeline.at(0)
        assertEquals(0f, first.startScale, 0f)
        assertEquals(0f, first.wire, 0f)
        assertEquals(0f, first.glowAlpha, 0f)
        assertNull(first.pulse)
        assertNull(first.ray)

        val last = AllaccioTimeline.final
        assertEquals(1f, last.startScale, 1e-4f)
        assertEquals(1f, last.wire, 1e-4f)
        assertEquals(2f, last.lampLit, 1e-4f)
        assertEquals(1f, last.lampScale, 1e-4f)
        assertEquals(0.28f, last.glowAlpha, 1e-3f)
        assertEquals(0f, last.sparkAlpha, 1e-4f)
        assertNull(last.pulse)
        assertNull(last.ray)
    }

    @Test
    fun wireIsLaidBeforeTheCurrentRunsAndTheLampWaitsForIt() {
        assertTrue(AllaccioTimeline.at(500).wire in 0.1f..0.9f)
        assertEquals(1f, AllaccioTimeline.at(880).wire, 1e-3f)
        assertNotNull(AllaccioTimeline.at(1_100).pulse)
        assertEquals(0f, AllaccioTimeline.at(1_100).lampLit, 0f)
        assertTrue(AllaccioTimeline.at(1_500).lampScale > 1f)
    }

    @Test
    fun lastsAboutTwoSecondsAndClampsOutOfRangeTimes() {
        assertTrue(AllaccioTimeline.TOTAL_MS in 1_800..2_000)
        assertEquals(AllaccioTimeline.final, AllaccioTimeline.at(10_000))
        assertEquals(AllaccioTimeline.at(0), AllaccioTimeline.at(-5))
    }

    @Test
    fun wireOnlyGrows() {
        var prev = 0f
        for (t in 0..AllaccioTimeline.TOTAL_MS step 20) {
            val w = AllaccioTimeline.at(t).wire
            assertTrue("t=$t", w >= prev - 1e-4f)
            prev = w
        }
    }
}
