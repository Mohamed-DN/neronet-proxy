package com.darknero.neronet

import androidx.annotation.StringRes
import java.io.IOException

enum class AddMethod { QR, FILE, PASTE }

sealed interface ImportResult {
    data class Imported(val id: String) : ImportResult
    data class Duplicate(val id: String, val title: String) : ImportResult
    /** The UI shows import_failed with the reason. */
    data class Invalid(@StringRes val reasonRes: Int) : ImportResult
    /** The UI shows read_failed. */
    data object TooLarge : ImportResult
    /** The UI shows qr_not_profile. */
    data object NotAProfile : ImportResult
}

/** Validates pasted, file or scanned profile text and saves it once per device key. */
class ProfileImporter(private val profiles: ProfileRepository) {

    fun importText(text: String): ImportResult {
        if (text.toByteArray(Charsets.UTF_8).size > MAX_PROFILE_BYTES) return ImportResult.TooLarge
        val profile = try {
            NeroNetProfile.parse(text)
        } catch (e: Exception) {
            return ImportResult.Invalid(ProfileErrorStrings.forThrowable(e))
        }
        profiles.findByPublicKey(profile.devicePublicKey)?.let { existing ->
            profiles.select(existing.id)
            return ImportResult.Duplicate(existing.id, existing.title)
        }
        return try {
            val id = profiles.add(text)
            profiles.select(id)
            ImportResult.Imported(id)
        } catch (e: IOException) {
            ImportResult.Invalid(R.string.reason_other)
        }
    }

    /** A QR code must at least contain an [Interface] section before it is parsed as a profile. */
    fun importQr(contents: String): ImportResult {
        if (contents.toByteArray(Charsets.UTF_8).size > MAX_PROFILE_BYTES) return ImportResult.TooLarge
        if (!contents.contains("[interface]", ignoreCase = true)) return ImportResult.NotAProfile
        return importText(contents)
    }

    companion object {
        const val MAX_PROFILE_BYTES = 64 * 1024
    }
}
