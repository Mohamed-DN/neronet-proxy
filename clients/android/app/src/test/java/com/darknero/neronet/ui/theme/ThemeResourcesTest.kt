package com.darknero.neronet.ui.theme

import android.content.Context
import androidx.core.content.ContextCompat
import androidx.core.content.res.ResourcesCompat
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.darknero.neronet.R
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ThemeResourcesTest {

    private val context = ApplicationProvider.getApplicationContext<Context>()

    @Test
    fun overpassFontResourceLoads() {
        assertNotNull(ResourcesCompat.getFont(context, R.font.overpass_variable))
    }

    @Test
    fun iconsLoad() {
        for (icon in listOf(R.drawable.ic_device, R.drawable.ic_qr, R.drawable.ic_copy)) {
            assertNotNull(ContextCompat.getDrawable(context, icon))
        }
    }

    @Test
    fun bodyLargeUsesOverpass() {
        assertEquals(OverpassFamily, NnTypography.bodyLarge.fontFamily)
    }

    @Test
    fun launcherAndTileIconsLoad() {
        for (icon in listOf(
            R.drawable.ic_launcher_foreground, R.drawable.ic_launcher_monochrome,
            R.drawable.ic_tile, R.drawable.ic_tile_off, R.drawable.ic_stat_neronet,
        )) {
            assertNotNull(ContextCompat.getDrawable(context, icon))
        }
    }

    @Test
    fun launcherBackgroundIsInk() {
        assertEquals(0xFF15232D.toInt(), ContextCompat.getColor(context, R.color.ic_launcher_background))
    }

    @Test
    fun wordmarkIsExtraBold() {
        assertEquals(androidx.compose.ui.text.font.FontWeight.ExtraBold, NnTextStyles.wordmark.fontWeight)
    }

    @Test
    fun tabularStyleUsesTabularFigures() {
        assertEquals("tnum", NnTextStyles.tabular.fontFeatureSettings)
    }
}
