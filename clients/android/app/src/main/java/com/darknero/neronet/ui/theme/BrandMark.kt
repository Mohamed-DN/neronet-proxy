package com.darknero.neronet.ui.theme

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * The NeroNet mark (brand guide): the N as a transit line, up, a 45 degree diagonal, up again, a ring at the
 * lower terminus and the signal-yellow dot at the upper one. Same geometry as the launcher icon (viewBox 48).
 * Decorative: the wordmark next to it carries the name.
 */
@Composable
fun BrandMark(modifier: Modifier = Modifier, size: Dp = 28.dp) {
    val p = LocalNnPalette.current
    Canvas(modifier.size(size)) {
        val k = this.size.minDimension / 48f
        val line = Path().apply {
            moveTo(12f * k, 39f * k)
            lineTo(12f * k, 13f * k)
            lineTo(36f * k, 37f * k)
            lineTo(36f * k, 9f * k)
        }
        drawPath(line, p.ink, style = Stroke(5.5f * k, cap = StrokeCap.Round, join = StrokeJoin.Round))
        val low = Offset(12f * k, 39f * k)
        val high = Offset(36f * k, 9f * k)
        drawCircle(p.surface, 4.6f * k, low)
        drawCircle(p.ink, 4.6f * k, low, style = Stroke(2.6f * k))
        drawCircle(p.signal, 4.6f * k, high)
        drawCircle(p.ink, 4.6f * k, high, style = Stroke(2.6f * k))
    }
}
