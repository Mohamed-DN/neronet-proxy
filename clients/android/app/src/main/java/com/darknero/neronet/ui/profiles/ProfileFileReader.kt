package com.darknero.neronet.ui.profiles

import android.content.ContentResolver
import android.net.Uri
import com.darknero.neronet.ProfileImporter
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream

/** Reads a profile file the user picked. Anything over the profile size limit is refused, not truncated. */
object ProfileFileReader {
    fun read(resolver: ContentResolver, uri: Uri): String? {
        val bytes = try {
            resolver.openInputStream(uri)?.use { readAtMost(it, ProfileImporter.MAX_PROFILE_BYTES) }
        } catch (e: IOException) {
            null
        } catch (e: SecurityException) {
            null
        }
        return bytes?.toString(Charsets.UTF_8)
    }

    private fun readAtMost(input: InputStream, limit: Int): ByteArray? {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            out.write(buffer, 0, count)
            if (out.size() > limit) return null
        }
        return out.toByteArray()
    }
}
