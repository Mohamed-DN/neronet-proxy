package com.darknero.neronet.ui.theme

import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.Easing

/** One instant of the Allaccio animation, every value already eased. Lengths are fractions of the wire. */
data class AllaccioFrame(
    val startScale: Float,
    /** Share of the wire that is laid, 0..1, from the lower terminus up. */
    val wire: Float,
    /** The yellow pulse as a [from, to] share of the wire; null while hidden. */
    val pulse: ClosedFloatingPointRange<Float>?,
    val pulseAlpha: Float,
    val lampScale: Float,
    /** 0 unlit, 1 pale flash, 2 signal yellow (blend between neighbours). */
    val lampLit: Float,
    val glowAlpha: Float,
    val glowScale: Float,
    val sparkAlpha: Float,
    val sparkScale: Float,
    /** Visible [from, to] share of each of the four rays. */
    val ray: ClosedFloatingPointRange<Float>?,
)

/**
 * The Allaccio ("plug in") logo animation as a pure function of time. Same timeline as the approved prototype
 * (allaccio.html): the lower terminus pops, the wire is laid up, a short current pulse runs along it, the lamp
 * lights with a small bounce, a glow settles, a ring and four rays flash once. The glow settling is cut to end
 * with the rest, so the whole animation is [TOTAL_MS].
 */
object AllaccioTimeline {
    const val TOTAL_MS = 1_900

    private const val START_AT = 50
    private const val START_MS = 220
    private const val WIRE_AT = 150
    private const val WIRE_MS = 720
    private const val PULSE_AT = 900
    private const val PULSE_MS = 550
    private const val LAMP_AT = 1_330
    private const val LAMP_MS = 500
    private const val GLOW_MS = TOTAL_MS - LAMP_AT
    private const val SPARK_AT = 1_350
    private const val SPARK_MS = 550
    private const val RAY_MS = 450

    /** Wire length 88 view units; the pulse is 9 of them (prototype dash 9). */
    private const val PULSE_LEN = 9f / 88f

    private val easeOut: Easing = CubicBezierEasing(0f, 0f, 0.58f, 1f)
    private val wireEase: Easing = CubicBezierEasing(0.55f, 0.05f, 0.25f, 1f)
    private val pulseEase: Easing = CubicBezierEasing(0.4f, 0f, 0.2f, 1f)
    private val lampEase: Easing = CubicBezierEasing(0.2f, 1.4f, 0.4f, 1f)

    /** Everything at rest: wire laid, lamp lit, glow settled. Also the reduced-motion frame. */
    val final: AllaccioFrame = at(TOTAL_MS)

    private fun progress(t: Int, at: Int, ms: Int): Float = ((t - at).toFloat() / ms).coerceIn(0f, 1f)

    private fun lerp(a: Float, b: Float, f: Float) = a + (b - a) * f

    fun at(tMs: Int): AllaccioFrame {
        val t = tMs.coerceIn(0, TOTAL_MS)

        val startScale = easeOut.transform(progress(t, START_AT, START_MS))
        val wire = wireEase.transform(progress(t, WIRE_AT, WIRE_MS))

        val pp = progress(t, PULSE_AT, PULSE_MS)
        val pulseOn = t >= PULSE_AT && pp < 1f
        val head = pulseEase.transform(pp) * (1f + PULSE_LEN * 2f) - PULSE_LEN
        val pulse = if (pulseOn) maxOf(0f, head)..minOf(1f, head + PULSE_LEN) else null
        val pulseAlpha = if (!pulseOn) 0f else if (pp < 0.9f) 1f else 1f - (pp - 0.9f) / 0.1f

        // Lamp keyframes 0% (unlit, .6) -> 40% (pale, 1.25) -> 100% (yellow, 1), each leg with the bounce curve.
        val lp = progress(t, LAMP_AT, LAMP_MS)
        val lit: Float
        val lampScale: Float
        if (t < LAMP_AT) {
            lit = 0f; lampScale = 1f
        } else if (lp < 0.4f) {
            val e = lampEase.transform(lp / 0.4f)
            lit = e; lampScale = lerp(0.6f, 1.25f, e)
        } else {
            val e = lampEase.transform((lp - 0.4f) / 0.6f)
            lit = 1f + e; lampScale = lerp(1.25f, 1f, e)
        }

        // Glow keyframes 0% (0, .4) -> 25% (.85, 1) -> 100% (.28, 1.15).
        val gp = progress(t, LAMP_AT, GLOW_MS)
        val glowAlpha: Float
        val glowScale: Float
        if (t < LAMP_AT) {
            glowAlpha = 0f; glowScale = 0.4f
        } else if (gp < 0.25f) {
            val e = easeOut.transform(gp / 0.25f)
            glowAlpha = lerp(0f, 0.85f, e); glowScale = lerp(0.4f, 1f, e)
        } else {
            val e = easeOut.transform((gp - 0.25f) / 0.75f)
            glowAlpha = lerp(0.85f, 0.28f, e); glowScale = lerp(1f, 1.15f, e)
        }

        val sp = easeOut.transform(progress(t, SPARK_AT, SPARK_MS))
        val sparkOn = t >= SPARK_AT
        val sparkAlpha = if (sparkOn) lerp(0.95f, 0f, sp) else 0f
        val sparkScale = if (sparkOn) lerp(0.5f, 2.6f, sp) else 0.5f

        val rp = easeOut.transform(progress(t, SPARK_AT, RAY_MS))
        val rayOn = t >= SPARK_AT && progress(t, SPARK_AT, RAY_MS) < 1f
        val ray = if (!rayOn) null else {
            val to = minOf(1f, rp / 0.6f)
            val from = maxOf(0f, (rp - 0.6f) / 0.4f)
            from..to
        }

        return AllaccioFrame(startScale, wire, pulse, pulseAlpha, lampScale, lit, glowAlpha, glowScale, sparkAlpha, sparkScale, ray)
    }

}
