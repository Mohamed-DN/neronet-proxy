package com.darknero.neronet.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.darknero.neronet.R

@OptIn(ExperimentalTextApi::class)
private fun interWeight(weight: FontWeight): Font = Font(
    resId = R.font.inter_variable,
    weight = weight,
    variationSettings = FontVariation.Settings(FontVariation.weight(weight.weight)),
)

/** Inter, the same variable font the console serves; the weight axis is driven per style. */
val InterFamily: FontFamily = FontFamily(
    interWeight(FontWeight.Normal),
    interWeight(FontWeight.Medium),
    interWeight(FontWeight.SemiBold),
)

private fun style(size: Int, line: Int, weight: FontWeight) = TextStyle(
    fontFamily = InterFamily,
    fontWeight = weight,
    fontSize = size.sp,
    lineHeight = line.sp,
)

private val base = Typography()

/** The D4 scale. Styles the design does not name keep Material's sizes but use Inter. */
val NnTypography: Typography = Typography(
    displayLarge = base.displayLarge.copy(fontFamily = InterFamily),
    displayMedium = base.displayMedium.copy(fontFamily = InterFamily),
    displaySmall = base.displaySmall.copy(fontFamily = InterFamily),
    headlineLarge = base.headlineLarge.copy(fontFamily = InterFamily),
    headlineMedium = style(28, 36, FontWeight.SemiBold),
    headlineSmall = base.headlineSmall.copy(fontFamily = InterFamily),
    titleLarge = style(22, 28, FontWeight.Medium),
    titleMedium = style(16, 24, FontWeight.Medium),
    titleSmall = base.titleSmall.copy(fontFamily = InterFamily),
    bodyLarge = style(16, 24, FontWeight.Normal),
    bodyMedium = style(14, 20, FontWeight.Normal),
    bodySmall = base.bodySmall.copy(fontFamily = InterFamily),
    labelLarge = style(14, 20, FontWeight.Medium),
    labelMedium = style(12, 16, FontWeight.Medium),
    labelSmall = base.labelSmall.copy(fontFamily = InterFamily),
)

object NnTextStyles {
    /** Map labels: 13/18 Medium (design D4). */
    val mapLabel: TextStyle = style(13, 18, FontWeight.Medium)

    /** Addresses, traffic and times: body text with tabular figures. */
    val tabular: TextStyle = NnTypography.bodyMedium.copy(fontFeatureSettings = "tnum")
}
