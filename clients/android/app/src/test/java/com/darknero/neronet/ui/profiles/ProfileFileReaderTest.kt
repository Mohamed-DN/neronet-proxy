package com.darknero.neronet.ui.profiles

import android.net.Uri
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import java.io.ByteArrayInputStream

@RunWith(AndroidJUnit4::class)
class ProfileFileReaderTest {
    private val resolver = ApplicationProvider.getApplicationContext<android.content.Context>().contentResolver

    @Test
    fun readsSmallFile() {
        val uri = Uri.parse("content://test/small.conf")
        val text = "[Interface]\nPrivateKey = test\n"
        shadowOf(resolver).registerInputStream(uri, ByteArrayInputStream(text.toByteArray()))

        assertEquals(text, ProfileFileReader.read(resolver, uri))
    }

    @Test
    fun refusesFileOver64KB() {
        val uri = Uri.parse("content://test/large.conf")
        val big = ByteArray(64 * 1024 + 1) { 'a'.code.toByte() }
        shadowOf(resolver).registerInputStream(uri, ByteArrayInputStream(big))

        assertNull(ProfileFileReader.read(resolver, uri))
    }
}
