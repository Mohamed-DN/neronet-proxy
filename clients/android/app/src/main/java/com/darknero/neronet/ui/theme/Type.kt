package com.darknero.neronet.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import com.darknero.neronet.R

@OptIn(ExperimentalTextApi::class)
private fun overpassWeight(weight: FontWeight): Font = Font(
    resId = R.font.overpass_variable,
    weight = weight,
    variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
)

/** Overpass (OFL), the variable font the console serves; the weight axis is driven per style. */
val OverpassFamily: FontFamily = FontFamily(
    overpassWeight(FontWeight.Normal),
    overpassWeight(FontWeight.Medium),
    overpassWeight(FontWeight.SemiBold),
    overpassWeight(FontWeight.ExtraBold),
)

private fun style(size: Int, line: Int, weight: FontWeight) = TextStyle(
    fontFamily = OverpassFamily,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = line.sp,
)

private val base = Typography()

/** The brand scale. Styles the design does not name keep Material's sizes but use Overpass. */
val NnTypography: Typography = Typography(
    displayLarge = base.displayLarge.copy(fontFamily = OverpassFamily),
    displayMedium = base.displayMedium.copy(fontFamily = OverpassFamily),
    displaySmall = base.displaySmall.copy(fontFamily = OverpassFamily),
    headlineLarge = base.headlineLarge.copy(fontFamily = OverpassFamily),
    headlineMedium = style(28, 36, FontWeight.SemiBold),
    headlineSmall = base.headlineSmall.copy(fontFamily = OverpassFamily),
    titleLarge = style(22, 28, FontWeight.Medium),
    titleMedium = style(16, 24, FontWeight.Medium),
    titleSmall = base.titleSmall.copy(fontFamily = OverpassFamily),
    bodyLarge = style(16, 24, FontWeight.Normal),
    bodyMedium = style(14, 20, FontWeight.Normal),
    bodySmall = base.bodySmall.copy(fontFamily = OverpassFamily),
    labelLarge = style(14, 20, FontWeight.Medium),
    labelMedium = style(12, 16, FontWeight.Medium),
    labelSmall = base.labelSmall.copy(fontFamily = OverpassFamily),
)

object NnTextStyles {
    /** The wordmark: Overpass ExtraBold, letter-spacing -1% (brand guide). */
    val wordmark: TextStyle = style(22, 28, FontWeight.ExtraBold).copy(letterSpacing = (-0.01).em)

    /** Map labels: 13/18 Medium (design D4). */
    val mapLabel: TextStyle = style(13, 18, FontWeight.Medium)

    /** Addresses, traffic and times: body text with tabular figures. */
    val tabular: TextStyle = NnTypography.bodyMedium.copy(fontFeatureSettings = "tnum")
}
