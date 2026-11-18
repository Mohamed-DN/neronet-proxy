package com.darknero.neronet.ui.theme

import com.darknero.neronet.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** The splash resources are checked as files: the v31 theme must point at the AVD, older ones at the static mark. */
class AllaccioSplashResourceTest {
    private fun res(path: String): File =
        listOf("src/main/res", "app/src/main/res").map { File(it, path) }.first { it.exists() }

    private fun end(animator: String): Int {
        val offset = Regex("startOffset=\"(\\d+)\"").find(animator)?.groupValues?.get(1)?.toInt() ?: 0
        return offset + Regex("duration=\"(\\d+)\"").find(animator)!!.groupValues[1].toInt()
    }

    @Test
    fun avdResourcesExist() {
        assertNotEquals(0, R.drawable.avd_allaccio)
        assertTrue(res("drawable/avd_allaccio.xml").readText().contains("<animated-vector"))
        assertTrue(res("drawable/avd_allaccio_mark.xml").readText().contains("<vector"))
    }

    @Test
    fun v31SplashThemeUsesTheAvdWithinThePlatformLimit() {
        val v31 = res("values-v31/themes.xml").readText()
        assertTrue(v31.contains("name=\"Theme.NeroNet.Splash\""))
        assertTrue(v31.contains("name=\"windowSplashScreenAnimatedIcon\">@drawable/avd_allaccio<"))
        val duration = Regex("windowSplashScreenAnimationDuration\">(\\d+)<").find(v31)!!.groupValues[1].toInt()
        assertTrue("splash animation $duration ms", duration <= 1_000)
    }

    @Test
    fun olderApisKeepTheStaticMark() {
        val base = res("values/themes.xml").readText()
        assertTrue(base.contains("windowSplashScreenAnimatedIcon\">@drawable/ic_launcher_foreground<"))
    }

    @Test
    fun everyAnimatorEndsWithinOneSecond() {
        val animators = Regex("<objectAnimator[^>]*>").findAll(res("drawable/avd_allaccio.xml").readText())
            .map { it.value }.toList()
        assertTrue(animators.isNotEmpty())
        for (a in animators) assertTrue("$a ends at ${end(a)}", end(a) <= 1_000)
        assertEquals(1_000, animators.maxOf { end(it) })
    }
}
