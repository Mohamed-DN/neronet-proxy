package com.darknero.neronet.ui

import android.content.Context
import android.text.format.Formatter
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.platform.LocalContext

/** Text the view models build without a Context. The screen resolves it with [resolve]. */
sealed interface UiText {
    /** A string resource. An entry of [args] may itself be a [UiText]; it is resolved first. */
    data class Res(@StringRes val id: Int, val args: List<Any> = emptyList()) : UiText

    /** A plurals resource; [count] is also the format argument. */
    data class Plural(@PluralsRes val id: Int, val count: Int) : UiText

    data class Plain(val text: String) : UiText

    /** A byte count, formatted the way the platform shows file sizes. */
    data class Bytes(val bytes: Long) : UiText
}

fun UiText.resolve(context: Context): String = when (this) {
    is UiText.Res -> context.getString(
        id,
        *args.map { if (it is UiText) it.resolve(context) else it }.toTypedArray(),
    )
    is UiText.Plural -> context.resources.getQuantityString(id, count, count)
    is UiText.Plain -> text
    is UiText.Bytes -> Formatter.formatShortFileSize(context, bytes)
}

@Composable
fun UiText.resolve(): String = resolve(LocalContext.current)
