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
    fun interFontResourceLoads() {
        assertNotNull(ResourcesCompat.getFont(context, R.font.inter_variable))
    }

    @Test
    fun iconsLoad() {
        for (icon in listOf(R.drawable.ic_device, R.drawable.ic_qr, R.drawable.ic_copy)) {
            assertNotNull(ContextCompat.getDrawable(context, icon))
        }
    }

    @Test
    fun bodyLargeUsesInter() {
        assertEquals(InterFamily, NnTypography.bodyLarge.fontFamily)
    }

    @Test
    fun tabularStyleUsesTabularFigures() {
        assertEquals("tnum", NnTextStyles.tabular.fontFeatureSettings)
    }
}
