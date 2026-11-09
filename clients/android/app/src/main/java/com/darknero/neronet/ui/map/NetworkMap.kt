package com.darknero.neronet.ui.map

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.AnimationSpec
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State as ComposeState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ColorFilter
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke as DrawStroke
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.darknero.neronet.R
import com.darknero.neronet.ui.theme.LocalNnPalette
import com.darknero.neronet.ui.theme.NnPalette
import com.darknero.neronet.ui.theme.NnTextStyles

/** The palette role for each colour role of the map; one to one by name (ruled in the ledger). */
private fun NnPalette.color(role: ColorRole): Color = when (role) {
    ColorRole.INK -> ink
    ColorRole.INK_MUTED -> inkMuted
    ColorRole.SURFACE -> surface
    ColorRole.RELIEF -> relief
    ColorRole.SIGNAL -> signal
    ColorRole.ON_SIGNAL -> onSignal
    ColorRole.CONNECTED -> connected
    ColorRole.ON_CONNECTED -> onConnected
    ColorRole.ALARM -> alarm
    ColorRole.OUTLINE -> outline
    ColorRole.OUTLINE_VARIANT -> outlineVariant
}

private const val DASH_DP = 4f
private const val PULSE_PERIOD_MS = 1600
private const val PULSE_RING_MS = 900
private const val LABEL_MAX_FONT_SCALE = 1.3f
private const val OVERFLOW_GAP = 0.02f
private const val PULSE_START = 0.12f
private const val PULSE_END = 0.27f
private const val PULSE_ALPHA = 0.55f
private val SPOKE_WIDTH = 1.5.dp
private val RING_WIDTH = 1.dp
private val NODE_WIDTH = 2.dp
private val ORG_WIDTH = 1.5.dp
private val LABEL_GAP = 8.dp

private fun colorSpec(reducedMotion: Boolean): AnimationSpec<Color> =
    if (reducedMotion) snap() else tween(durationMillis = 250)

/**
 * The network map. It is the connection switch: the device node toggles the tunnel, and the rest of the
 * picture shows what the profile states and what the handshake proves (design D3).
 */
@Composable
fun NetworkMap(
    state: MapState,
    topology: MapTopology,
    peerResponded: List<Boolean>,
    pictureDescription: String,
    switchLabel: String,
    stateDescription: String,
    switchOn: Boolean,
    switchEnabled: Boolean,
    onToggle: (Boolean) -> Unit,
    deviceLabel: String,
    gatewayLabel: String?,
    networkLabel: String?,
    networkCaption: String?,
    overflowLabel: String?,
    modifier: Modifier = Modifier,
    reducedMotion: Boolean = rememberReducedMotion(),
) {
    val palette = LocalNnPalette.current
    val layout = MapGeometry.layout(topology)
    val device = MapVisuals.device(state)
    val spec = colorSpec(reducedMotion)
    val deviceFill by animateColorAsState(palette.color(device.fill), spec, label = "device fill")
    val deviceOutline by animateColorAsState(palette.color(device.outline), spec, label = "device outline")
    val deviceGlyph by animateColorAsState(palette.color(device.glyph), spec, label = "device glyph")
    val switchStateText = stateDescription
    val labelsComposed = LocalDensity.current.fontScale <= LABEL_MAX_FONT_SCALE
    val gatewayResponded = peerResponded.firstOrNull() ?: false

    // Only while the nodes wait for a real answer, and never with reduced motion. Read in draw, not in composition.
    val pulse: ComposeState<Float>? = if (MapVisuals.pulseEnabled(state, reducedMotion)) {
        rememberInfiniteTransition(label = "connect pulse").animateFloat(
            initialValue = 0f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = keyframes {
                    durationMillis = PULSE_PERIOD_MS
                    0f at 0
                    1f at PULSE_RING_MS with FastOutSlowInEasing
                    1f at PULSE_PERIOD_MS
                },
                repeatMode = RepeatMode.Restart,
            ),
            label = "pulse ring",
        )
    } else {
        null
    }

    BoxWithConstraints(modifier = modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        val sizeDp = MapGeometry.mapSizeDp(maxWidth.value, maxHeight.value)
        val side: Dp = sizeDp.dp
        // Labels sit in the square's coordinates; their width runs to the container's right edge.
        val squareLeft: Dp = (maxWidth - side) / 2
        val touchDp = MapGeometry.touchTargetDp(sizeDp)

        fun labelWidth(x: Dp): Dp = maxWidth - squareLeft - x - LABEL_GAP

        Box(Modifier.size(side)) {
            Canvas(
                Modifier
                    .fillMaxSize()
                    .testTag("map_picture")
                    .semantics { contentDescription = pictureDescription },
            ) {
                val s = size.width
                val centre = Offset(layout.device.x * s, layout.device.y * s)
                fun at(n: NodeSpec) = Offset(n.x * s, n.y * s)

                layout.ringRadius?.let { r ->
                    MapVisuals.ring(state)?.let { stroke ->
                        drawRing(palette, stroke, centre, r * s)
                    }
                }
                layout.peers.forEachIndexed { index, peer ->
                    val visual = MapVisuals.peer(state, peerResponded.getOrElse(index) { false })
                    drawSpoke(palette, visual.spoke, centre, at(peer))
                }
                layout.org?.let { org ->
                    drawSpoke(palette, MapVisuals.org(state, gatewayResponded).stroke, centre, at(org))
                }

                // Connect pulse: one ring grows out from the device and fades.
                pulse?.value?.let { progress ->
                    if (progress < 1f) {
                        val radius = (PULSE_START + (PULSE_END - PULSE_START) * progress) * s
                        drawCircle(
                            color = palette.signal.copy(alpha = PULSE_ALPHA * (1f - progress)),
                            radius = radius,
                            center = centre,
                            style = DrawStroke(width = 2.dp.toPx()),
                        )
                    }
                }

                layout.peers.forEachIndexed { index, peer ->
                    val visual = MapVisuals.peer(state, peerResponded.getOrElse(index) { false })
                    drawNode(palette, visual.fill, visual.fillAlpha, visual.stroke, at(peer), peer.r * s, NODE_WIDTH)
                }
                layout.org?.let { org ->
                    val visual = MapVisuals.org(state, gatewayResponded)
                    drawNode(palette, visual.fill, visual.fillAlpha, visual.stroke, at(org), org.r * s, ORG_WIDTH)
                }

                drawCircle(deviceFill, radius = layout.device.r * s, center = centre)
                drawCircle(
                    color = deviceOutline,
                    radius = layout.device.r * s,
                    center = centre,
                    style = DrawStroke(width = NODE_WIDTH.toPx()),
                )
            }

            // The switch: a circle around the device, at least 48 dp across.
            Box(
                Modifier
                    .offset(
                        x = (layout.device.x * sizeDp - touchDp / 2).dp,
                        y = (layout.device.y * sizeDp - touchDp / 2).dp,
                    )
                    .size(touchDp.dp)
                    .clip(CircleShape)
                    .testTag("map_device")
                    .toggleable(
                        value = switchOn,
                        enabled = switchEnabled,
                        role = Role.Switch,
                        onValueChange = onToggle,
                    )
                    .semantics {
                        this.contentDescription = switchLabel
                        this.stateDescription = switchStateText
                    },
                contentAlignment = Alignment.Center,
            ) {
                Image(
                    painter = painterResource(R.drawable.ic_device),
                    contentDescription = null,
                    colorFilter = ColorFilter.tint(deviceGlyph),
                    modifier = Modifier.size((0.10f * sizeDp).dp),
                )
            }

            if (labelsComposed) {
                MapLabel(
                    text = deviceLabel,
                    tag = "map_label_device",
                    color = palette.ink,
                    maxLines = 1,
                    align = TextAlign.Center,
                    modifier = Modifier.align(Alignment.TopCenter).offset(y = (0.70f * sizeDp).dp).width(side),
                )

                if (topology is MapTopology.Gateway && gatewayLabel != null) {
                    val x = 0.575f * sizeDp
                    MapLabelAt(x = x.dp, centreY = (0.29f * sizeDp).dp, width = labelWidth(x.dp)) {
                        MapLabel(gatewayLabel, "map_label_gateway", palette.ink, maxLines = 2)
                    }
                }
                if (topology is MapTopology.Gateway && networkLabel != null) {
                    val x = 0.60f * sizeDp
                    MapLabelAt(x = x.dp, centreY = (0.12f * sizeDp).dp, width = labelWidth(x.dp)) {
                        Column(Modifier.clearAndSetSemantics { this[SemanticsProperties.TestTag] = "map_label_org" }) {
                            MapLabel(networkLabel, null, palette.ink, maxLines = 2)
                            if (networkCaption != null) {
                                MapLabel(networkCaption, null, palette.inkMuted, maxLines = 1)
                            }
                        }
                    }
                }
                val sixth = layout.peers.getOrNull(5)
                if (layout.overflowCount > 0 && overflowLabel != null && sixth != null) {
                    val x = (sixth.x + sixth.r + OVERFLOW_GAP) * sizeDp
                    MapLabelAt(x = x.dp, centreY = (sixth.y * sizeDp).dp, width = labelWidth(x.dp)) {
                        MapLabel(overflowLabel, "map_label_overflow", palette.inkMuted, maxLines = 1)
                    }
                }
            }
        }
    }
}

/** A label whose vertical centre is at [centreY] inside the square. */
@Composable
private fun MapLabelAt(x: Dp, centreY: Dp, width: Dp, content: @Composable () -> Unit) {
    Box(
        Modifier
            .offset(x = x)
            .width(width)
            .height(centreY * 2),
        contentAlignment = Alignment.CenterStart,
    ) {
        content()
    }
}

/**
 * A map label. Its text is hidden from TalkBack (the map description and the status sentence say it);
 * the test tag keeps it findable in tests.
 */
@Composable
private fun MapLabel(
    text: String,
    tag: String?,
    color: Color,
    maxLines: Int,
    align: TextAlign = TextAlign.Start,
    modifier: Modifier = Modifier,
) {
    Text(
        text = text,
        style = NnTextStyles.mapLabel,
        color = color,
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
        textAlign = align,
        modifier = modifier.clearAndSetSemantics {
            if (tag != null) this[SemanticsProperties.TestTag] = tag
        },
    )
}

private fun DrawScope.dashFor(stroke: Stroke): PathEffect? =
    if (stroke.dashed) PathEffect.dashPathEffect(floatArrayOf(DASH_DP.dp.toPx(), DASH_DP.dp.toPx())) else null

private fun DrawScope.drawRing(palette: NnPalette, stroke: Stroke, centre: Offset, radius: Float) {
    val color = palette.color(stroke.role).copy(alpha = stroke.alpha)
    if (color.alpha == 0f) return
    drawCircle(color = color, radius = radius, center = centre, style = DrawStroke(RING_WIDTH.toPx(), pathEffect = dashFor(stroke)))
}

private fun DrawScope.drawSpoke(palette: NnPalette, stroke: Stroke, from: Offset, to: Offset) {
    val color = palette.color(stroke.role).copy(alpha = stroke.alpha)
    if (color.alpha == 0f) return
    drawLine(color = color, start = from, end = to, strokeWidth = SPOKE_WIDTH.toPx(), pathEffect = dashFor(stroke))
}

private fun DrawScope.drawNode(
    palette: NnPalette,
    fill: ColorRole?,
    fillAlpha: Float,
    stroke: Stroke,
    centre: Offset,
    radius: Float,
    width: Dp,
) {
    if (fill != null && fillAlpha > 0f) {
        drawCircle(color = palette.color(fill).copy(alpha = fillAlpha), radius = radius, center = centre)
    }
    val color = palette.color(stroke.role).copy(alpha = stroke.alpha)
    if (color.alpha == 0f) return
    drawCircle(color = color, radius = radius, center = centre, style = DrawStroke(width.toPx(), pathEffect = dashFor(stroke)))
}
