package com.darknero.neronet.ui.map

import kotlin.math.cos
import kotlin.math.sin

/** The map's states (D3). Each one has a colour row in [MapVisuals]. */
enum class MapState { NO_PROFILE, IDLE, CONNECTING, WAITING, PROTECTED, STALE, DISCONNECTING, ERROR }

/** What the profile says about the network: no profile, the normal single gateway, or several servers. */
sealed interface MapTopology {
    data object DeviceOnly : MapTopology
    data class Gateway(val fullTunnel: Boolean) : MapTopology
    data class Servers(val count: Int) : MapTopology
}

/** A circle in fractions of the square side S (origin top-left, y down). */
data class NodeSpec(val x: Float, val y: Float, val r: Float)

data class MapLayout(
    val device: NodeSpec,
    /** Radius of the orbit, or null when no ring is drawn. */
    val ringRadius: Float?,
    val peers: List<NodeSpec>,
    /** Servers beyond the five shown; the sixth drawn node stands for them. */
    val overflowCount: Int,
    /** The organisation network, drawn only for a gateway. */
    val org: NodeSpec?,
)

object MapGeometry {
    private const val DEVICE_X = 0.50f
    private const val DEVICE_Y = 0.56f
    private const val DEVICE_R = 0.12f
    private const val RING_R = 0.27f
    private const val PEER_R = 0.045f
    private const val MAX_DRAWN = 6

    private val device = NodeSpec(DEVICE_X, DEVICE_Y, DEVICE_R)

    fun layout(topology: MapTopology): MapLayout = when (topology) {
        MapTopology.DeviceOnly -> MapLayout(device, null, emptyList(), 0, null)
        is MapTopology.Gateway -> MapLayout(
            device = device,
            ringRadius = RING_R,
            peers = listOf(onRing(0, 1)),
            overflowCount = 0,
            // On the gateway's ray at distance 0.44 from the device: (0.50, 0.12).
            org = NodeSpec(0.50f, 0.12f, 0.07f),
        )
        is MapTopology.Servers -> {
            require(topology.count >= 2) { "Servers needs at least two peers, got ${topology.count}" }
            val drawn = minOf(topology.count, MAX_DRAWN)
            MapLayout(
                device = device,
                ringRadius = RING_R,
                peers = (0 until drawn).map { onRing(it, drawn) },
                overflowCount = if (topology.count > MAX_DRAWN) topology.count - (MAX_DRAWN - 1) else 0,
                org = null,
            )
        }
    }

    /** Side of the square in dp: the smaller side, clamped to 240..480 dp, and never more than is available. */
    fun mapSizeDp(availableWidthDp: Float, availableHeightDp: Float): Float {
        val side = minOf(availableWidthDp, availableHeightDp)
        return if (side < 240f) side else minOf(side, 480f)
    }

    /** The touch target is a circle around the device: at least 48 dp across. */
    fun touchTargetDp(sizeDp: Float): Float = maxOf(2f * DEVICE_R * sizeDp, 48f)

    /** Node k of m on the ring; k = 0 is at the top and the angle grows clockwise. */
    private fun onRing(k: Int, m: Int): NodeSpec {
        val angle = Math.toRadians(-90.0 + k * 360.0 / m)
        return NodeSpec(
            x = DEVICE_X + RING_R * cos(angle).toFloat(),
            y = DEVICE_Y + RING_R * sin(angle).toFloat(),
            r = PEER_R,
        )
    }
}

/** Colour roles from the palette (D4). The UI maps each role to a token; this file has no colours. */
enum class ColorRole { INK, INK_MUTED, SURFACE, RELIEF, SIGNAL, ON_SIGNAL, CONNECTED, ON_CONNECTED, ALARM, OUTLINE, OUTLINE_VARIANT }

data class Stroke(val role: ColorRole, val alpha: Float = 1f, val dashed: Boolean = false)

data class DeviceVisual(val fill: ColorRole, val outline: ColorRole, val glyph: ColorRole)

data class PeerVisual(val fill: ColorRole?, val fillAlpha: Float, val stroke: Stroke, val spoke: Stroke)

data class OrgVisual(val stroke: Stroke, val fill: ColorRole?, val fillAlpha: Float)

/** The colour rules (D3 table). Green appears only in [MapState.PROTECTED]. */
object MapVisuals {

    /** A stroke with alpha 0: the element is hidden but keeps its place in the layout. */
    private val hiddenStroke = Stroke(ColorRole.OUTLINE_VARIANT, alpha = 0f)

    fun device(state: MapState): DeviceVisual = when (state) {
        MapState.NO_PROFILE -> DeviceVisual(ColorRole.RELIEF, ColorRole.OUTLINE, ColorRole.INK_MUTED)
        MapState.IDLE -> DeviceVisual(ColorRole.RELIEF, ColorRole.OUTLINE, ColorRole.INK)
        MapState.CONNECTING, MapState.WAITING -> DeviceVisual(ColorRole.SIGNAL, ColorRole.SIGNAL, ColorRole.ON_SIGNAL)
        MapState.PROTECTED -> DeviceVisual(ColorRole.CONNECTED, ColorRole.CONNECTED, ColorRole.ON_CONNECTED)
        MapState.STALE -> DeviceVisual(ColorRole.RELIEF, ColorRole.ALARM, ColorRole.ALARM)
        MapState.DISCONNECTING -> DeviceVisual(ColorRole.RELIEF, ColorRole.OUTLINE, ColorRole.INK_MUTED)
        MapState.ERROR -> DeviceVisual(ColorRole.RELIEF, ColorRole.ALARM, ColorRole.ALARM)
    }

    fun ring(state: MapState): Stroke? = when (state) {
        MapState.NO_PROFILE -> null
        MapState.IDLE, MapState.CONNECTING -> Stroke(ColorRole.OUTLINE_VARIANT, dashed = true)
        MapState.WAITING -> Stroke(ColorRole.OUTLINE_VARIANT)
        MapState.PROTECTED -> Stroke(ColorRole.CONNECTED, alpha = 0.4f)
        MapState.STALE -> Stroke(ColorRole.OUTLINE_VARIANT)
        MapState.DISCONNECTING, MapState.ERROR -> Stroke(ColorRole.OUTLINE_VARIANT, dashed = true)
    }

    /** "Responded" means this peer's last handshake is at most 180 s old. */
    fun peer(state: MapState, responded: Boolean): PeerVisual {
        val signalPending = PeerVisual(
            fill = null, fillAlpha = 0f,
            stroke = Stroke(ColorRole.SIGNAL, alpha = 0.6f, dashed = true),
            spoke = Stroke(ColorRole.SIGNAL, alpha = 0.4f, dashed = true),
        )
        return when (state) {
            MapState.NO_PROFILE -> PeerVisual(null, 0f, hiddenStroke, hiddenStroke)
            MapState.IDLE -> PeerVisual(
                fill = ColorRole.RELIEF, fillAlpha = 1f,
                stroke = Stroke(ColorRole.OUTLINE),
                spoke = Stroke(ColorRole.OUTLINE_VARIANT, dashed = true),
            )
            MapState.CONNECTING -> signalPending
            MapState.WAITING -> if (responded) {
                PeerVisual(ColorRole.SIGNAL, 1f, Stroke(ColorRole.SIGNAL), Stroke(ColorRole.SIGNAL))
            } else {
                signalPending
            }
            MapState.PROTECTED -> if (responded) {
                PeerVisual(ColorRole.CONNECTED, 1f, Stroke(ColorRole.CONNECTED), Stroke(ColorRole.CONNECTED))
            } else {
                PeerVisual(null, 0f, Stroke(ColorRole.OUTLINE), Stroke(ColorRole.OUTLINE_VARIANT, dashed = true))
            }
            MapState.STALE -> PeerVisual(
                null, 0f,
                Stroke(ColorRole.ALARM, dashed = true),
                Stroke(ColorRole.ALARM, dashed = true),
            )
            MapState.DISCONNECTING -> PeerVisual(
                null, 0f,
                Stroke(ColorRole.OUTLINE),
                Stroke(ColorRole.OUTLINE_VARIANT, dashed = true),
            )
            MapState.ERROR -> PeerVisual(
                null, 0f,
                Stroke(ColorRole.OUTLINE, dashed = true),
                Stroke(ColorRole.OUTLINE_VARIANT, dashed = true),
            )
        }
    }

    fun org(state: MapState, gatewayResponded: Boolean): OrgVisual {
        val dashedVariant = OrgVisual(Stroke(ColorRole.OUTLINE_VARIANT, dashed = true), null, 0f)
        return when (state) {
            MapState.NO_PROFILE -> OrgVisual(hiddenStroke, null, 0f)
            MapState.IDLE, MapState.CONNECTING, MapState.STALE, MapState.DISCONNECTING, MapState.ERROR -> dashedVariant
            MapState.WAITING -> if (gatewayResponded) OrgVisual(Stroke(ColorRole.SIGNAL), null, 0f) else dashedVariant
            MapState.PROTECTED -> OrgVisual(Stroke(ColorRole.CONNECTED), ColorRole.CONNECTED, 0.12f)
        }
    }

    /** The connect pulse runs only while the nodes are waiting for a real answer, and never with reduced motion. */
    fun pulseEnabled(state: MapState, reducedMotion: Boolean): Boolean =
        !reducedMotion && (state == MapState.CONNECTING || state == MapState.WAITING)
}
