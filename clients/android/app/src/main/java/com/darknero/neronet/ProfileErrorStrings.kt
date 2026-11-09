package com.darknero.neronet

import androidx.annotation.StringRes

/**
 * Maps a rejected profile to the localized text the user sees. Anything without a known reason
 * falls back to a generic string, so English exception text never reaches the Italian UI.
 */
object ProfileErrorStrings {

    @StringRes
    fun forReason(reason: ProfileReason): Int = when (reason) {
        ProfileReason.VERSION -> R.string.reason_version
        ProfileReason.CONSOLE_NOT_HTTPS -> R.string.reason_console_https
        ProfileReason.REFUSED_SETTING -> R.string.reason_refused_setting
        ProfileReason.UNKNOWN_SETTING -> R.string.reason_unknown_setting
        ProfileReason.UNKNOWN_SECTION -> R.string.reason_unknown_section
        ProfileReason.SYNTAX -> R.string.reason_syntax
        ProfileReason.BAD_VALUE -> R.string.reason_bad_value
        ProfileReason.MISSING_PRIVATE_KEY -> R.string.reason_missing_private_key
        ProfileReason.MISSING_PEER -> R.string.reason_missing_peer
        ProfileReason.MISSING_PUBLIC_KEY -> R.string.reason_missing_public_key
        ProfileReason.WIREGUARD_REJECTED -> R.string.reason_wireguard
    }

    /** The text for any failure while importing: a known profile reason, or the generic fallback. */
    @StringRes
    fun forThrowable(error: Throwable): Int =
        if (error is ProfileException) forReason(error.reason) else R.string.reason_other
}
