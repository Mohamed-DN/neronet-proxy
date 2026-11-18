package com.darknero.neronet.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.unit.dp

private val NnShapes = Shapes(
    small = RoundedCornerShape(4.dp),
    medium = RoundedCornerShape(8.dp),
)

/** Material 3 mapped onto the NeroNet palette. No dynamic colour: the palette is the brand. */
@Composable
fun NeroNetTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val p = if (darkTheme) NnPalettes.Dark else NnPalettes.Light
    // primary = ink plate with sheet text; tertiary = the brand signal (focus, "you are here"), never text.
    val scheme = if (darkTheme) {
        darkColorScheme(
            primary = p.ink, onPrimary = p.surface,
            tertiary = p.signal, onTertiary = p.onSignal,
            background = p.surface, surface = p.surface,
            surfaceContainer = p.relief, surfaceContainerHigh = p.relief,
            onSurface = p.ink, onBackground = p.ink, onSurfaceVariant = p.inkMuted,
            error = p.alarm, onError = p.onAlarm,
            outline = p.outline, outlineVariant = p.outlineVariant,
        )
    } else {
        lightColorScheme(
            primary = p.ink, onPrimary = p.surface,
            tertiary = p.signal, onTertiary = p.onSignal,
            background = p.surface, surface = p.surface,
            surfaceContainer = p.relief, surfaceContainerHigh = p.relief,
            onSurface = p.ink, onBackground = p.ink, onSurfaceVariant = p.inkMuted,
            error = p.alarm, onError = p.onAlarm,
            outline = p.outline, outlineVariant = p.outlineVariant,
        )
    }
    CompositionLocalProvider(LocalNnPalette provides p) {
        MaterialTheme(colorScheme = scheme, typography = NnTypography, shapes = NnShapes, content = content)
    }
}
