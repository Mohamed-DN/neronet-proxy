package com.darknero.neronet.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class LayoutModeTest {
    @Test
    fun phonePortraitIsSingle() = assertEquals(LayoutMode.SINGLE, LayoutMode.of(411, 891))

    @Test
    fun tabletLandscapeIsTwoPane() = assertEquals(LayoutMode.TWO_PANE, LayoutMode.of(891, 411))

    @Test
    fun tabletPortraitIsSingle() = assertEquals(LayoutMode.SINGLE, LayoutMode.of(800, 1280))

    @Test
    fun largeTabletLandscapeIsTwoPane() = assertEquals(LayoutMode.TWO_PANE, LayoutMode.of(1280, 800))

    @Test
    fun wideTabletPortraitIsTwoPane() = assertEquals(LayoutMode.TWO_PANE, LayoutMode.of(900, 1200))

    @Test
    fun shortWindowIsSingle() = assertEquals(LayoutMode.SINGLE, LayoutMode.of(599, 300))
}
