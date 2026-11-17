package com.darknero.neronet.ui.theme

import androidx.compose.runtime.ProvidableCompositionLocal
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/** The NeroNet colour roles (design direction D4). Light and dark values are pinned by PaletteContrastTest. */
data class NnPalette(
    val ink: Color,
    val inkMuted: Color,
    val surface: Color,
    val relief: Color,
    val signal: Color,
    val onSignal: Color,
    val connected: Color,
    val onConnected: Color,
    val alarm: Color,
    val onAlarm: Color,
    val outline: Color,
    val outlineVariant: Color,
)

object NnPalettes {
    val Light = NnPalette(
        ink = Color(0xFF0F172A),
        inkMuted = Color(0xFF475569),
        surface = Color(0xFFF8FAFC),
        relief = Color(0xFFFFFFFF),
        signal = Color(0xFF1D4ED8),
        onSignal = Color(0xFFFFFFFF),
        connected = Color(0xFF15803D),
        onConnected = Color(0xFFFFFFFF),
        alarm = Color(0xFFB91C1C),
        onAlarm = Color(0xFFFFFFFF),
        outline = Color(0xFF64748B),
        outlineVariant = Color(0xFFCBD5E1),
    )

    val Dark = NnPalette(
        ink = Color(0xFFF1F5F9),
        inkMuted = Color(0xFF94A3B8),
        surface = Color(0xFF0F172A),
        relief = Color(0xFF1E293B),
        signal = Color(0xFF60A5FA),
        onSignal = Color(0xFF0F172A),
        connected = Color(0xFF4ADE80),
        onConnected = Color(0xFF0F172A),
        alarm = Color(0xFFF87171),
        onAlarm = Color(0xFF450A0A),
        outline = Color(0xFF64748B),
        outlineVariant = Color(0xFF334155),
    )
}

val LocalNnPalette: ProvidableCompositionLocal<NnPalette> = staticCompositionLocalOf { NnPalettes.Light }
