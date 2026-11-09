package com.darknero.neronet

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(AndroidJUnit4::class)
class StringsLocaleTest {

    private val resources get() = ApplicationProvider.getApplicationContext<Context>().resources

    @Test
    @Config(qualifiers = "it")
    fun italianResourcesAreUsed() {
        assertEquals("Protetto", resources.getString(R.string.status_protected_title))
        assertEquals("da 12 minuti", resources.getQuantityString(R.plurals.elapsed_minutes, 12, 12))
        assertEquals("da 1 minuto", resources.getQuantityString(R.plurals.elapsed_minutes, 1, 1))
    }

    @Test
    @Config(qualifiers = "en")
    fun englishResourcesAreUsed() {
        assertEquals("Protected", resources.getString(R.string.status_protected_title))
        assertEquals("for 12 minutes", resources.getQuantityString(R.plurals.elapsed_minutes, 12, 12))
        assertEquals("Disconnect", resources.getString(R.string.action_disconnect))
    }
}
