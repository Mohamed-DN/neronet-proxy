package com.darknero.neronet.ui.theme

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.tween
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathMeasure
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.lerp
import com.darknero.neronet.ui.map.rememberReducedMotion
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
/**
 * With [animate] the mark plays Allaccio once (see [AllaccioTimeline], 1.9 s) and calls [onDone]; it never loops.
 * With [reducedMotion] (system animations off) it shows the final frame at once and calls [onDone] right away.
 */
@Composable
fun BrandMark(
    modifier: Modifier = Modifier,
    size: Dp = 28.dp,
    animate: Boolean = false,
    onDone: () -> Unit = {},
    reducedMotion: Boolean = rememberReducedMotion(),
) {
    if (!animate) {
        StaticBrandMark(modifier, size)
        return
    }
    val p = LocalNnPalette.current
    val clock = remember { Animatable(if (reducedMotion) AllaccioTimeline.TOTAL_MS.toFloat() else 0f) }
    val done by rememberUpdatedState(onDone)
    LaunchedEffect(reducedMotion) {
        if (!reducedMotion) {
            clock.snapTo(0f)
            clock.animateTo(AllaccioTimeline.TOTAL_MS.toFloat(), tween(AllaccioTimeline.TOTAL_MS, easing = LinearEasing))
        }
        done()
    }
    Canvas(modifier.size(size)) {
        drawAllaccio(AllaccioTimeline.at(clock.value.toInt()), p, this.size.minDimension / 48f)
    }
}

private val PaleLamp = Color(0xFFFFF3B0)

private fun DrawScope.drawAllaccio(f: AllaccioFrame, p: NnPalette, k: Float) {
    val low = Offset(12f * k, 39f * k)
    val high = Offset(36f * k, 9f * k)
    val line = Path().apply {
        moveTo(12f * k, 39f * k)
        lineTo(12f * k, 13f * k)
        lineTo(36f * k, 37f * k)
        lineTo(36f * k, 9f * k)
    }
    val measure = PathMeasure().apply { setPath(line, false) }
    val len = measure.length
    fun part(from: Float, to: Float): Path = Path().also { measure.getSegment(len * from, len * to, it, true) }

    if (f.glowAlpha > 0f) {
        val r = 11f * k * f.glowScale
        drawCircle(
            Brush.radialGradient(listOf(p.signal.copy(alpha = 0.9f), p.signal.copy(alpha = 0f)), high, r),
            r, high, alpha = f.glowAlpha,
        )
    }
    if (f.wire > 0f) {
        drawPath(part(0f, f.wire), p.ink, style = Stroke(5.5f * k, cap = StrokeCap.Round, join = StrokeJoin.Round))
    }
    f.pulse?.let {
        drawPath(
            part(it.start, it.endInclusive), p.signal, alpha = f.pulseAlpha,
            style = Stroke(3f * k, cap = StrokeCap.Round, join = StrokeJoin.Round),
        )
    }
    scale(f.startScale, low) {
        drawCircle(p.surface, 4.6f * k, low)
        drawCircle(p.ink, 4.6f * k, low, style = Stroke(2.6f * k))
    }
    if (f.sparkAlpha > 0f) {
        drawCircle(p.signal, 5f * k * f.sparkScale, high, alpha = f.sparkAlpha, style = Stroke(1.4f * k))
    }
    f.ray?.let { r ->
        val rays = listOf(
            Offset(36f, 1.5f) to Offset(36f, -1.5f),
            Offset(43.5f, 9f) to Offset(46.5f, 9f),
            Offset(41.3f, 3.7f) to Offset(43.4f, 1.6f),
            Offset(30.7f, 3.7f) to Offset(28.6f, 1.6f),
        )
        for ((a, b) in rays) {
            val s = Offset(a.x + (b.x - a.x) * r.start, a.y + (b.y - a.y) * r.start) * k
            val e = Offset(a.x + (b.x - a.x) * r.endInclusive, a.y + (b.y - a.y) * r.endInclusive) * k
            drawLine(p.signal, s, e, 1.6f * k, StrokeCap.Round)
        }
    }
    val lamp = if (f.lampLit <= 1f) lerp(p.relief, PaleLamp, f.lampLit) else lerp(PaleLamp, p.signal, f.lampLit - 1f)
    scale(f.lampScale, high) {
        drawCircle(lamp, 4.6f * k, high)
        drawCircle(p.ink, 4.6f * k, high, style = Stroke(2.6f * k))
    }
}

@Composable
private fun StaticBrandMark(modifier: Modifier = Modifier, size: Dp = 28.dp) {
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
