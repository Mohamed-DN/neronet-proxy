package com.darknero.neronet.ui.theme

import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * The NeroNet colour roles (brand tokens, docs/design/DIRECTION-2026-11.md). Light and dark values are pinned by
 * PaletteContrastTest. [signal] is the brand yellow: "you are here" and focus only, never text. [progress] is the
 * info colour for work in flight (connecting, waiting).
 */
data class NnPalette(
    val ink: Color,
    val inkMuted: Color,
    val surface: Color,
    val relief: Color,
    val signal: Color,
    val onSignal: Color,
    val progress: Color,
    val connected: Color,
    val onConnected: Color,
    val alarm: Color,
    val onAlarm: Color,
    val outline: Color,
    val outlineVariant: Color,
)

object NnPalettes {
    val Light = NnPalette(
        ink = Color(0xFF15232D),
        inkMuted = Color(0xFF4E5D66),
        surface = Color(0xFFF2F4F3),
        relief = Color(0xFFFFFFFF),
        signal = Color(0xFFF5C211),
        onSignal = Color(0xFF15232D),
        progress = Color(0xFF6D28D9),
        connected = Color(0xFF126E34),
        onConnected = Color(0xFFFFFFFF),
        alarm = Color(0xFFB71C1C),
        onAlarm = Color(0xFFFFFFFF),
        outline = Color(0xFF6B7B84),
        outlineVariant = Color(0xFFC9D2D6),
    )

    val Dark = NnPalette(
        ink = Color(0xFFE8EEF0),
        inkMuted = Color(0xFFA3B3BA),
        surface = Color(0xFF0E1A22),
        relief = Color(0xFF16252F),
        signal = Color(0xFFF5C211),
        onSignal = Color(0xFF15232D),
        progress = Color(0xFFAA8EFA),
        connected = Color(0xFF4ADE80),
        onConnected = Color(0xFF0E1A22),
        alarm = Color(0xFFF87171),
        onAlarm = Color(0xFF0E1A22),
        outline = Color(0xFF6F8794),
        outlineVariant = Color(0xFF2E4250),
    )
}

val LocalNnPalette: ProvidableCompositionLocal<NnPalette> = staticCompositionLocalOf { NnPalettes.Light }
