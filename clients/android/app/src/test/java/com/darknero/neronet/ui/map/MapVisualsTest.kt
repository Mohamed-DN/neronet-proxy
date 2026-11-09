package com.darknero.neronet.ui.map

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** One assertion group per row of the D3 colour table. */
class MapVisualsTest {

    private fun near(expected: Float, actual: Float) =
        assertEquals(expected.toDouble(), actual.toDouble(), 1e-4)

    // Device node (fill / outline / glyph)

    @Test
    fun noProfileDeviceIsReliefWithMutedGlyph() {
        val d = MapVisuals.device(MapState.NO_PROFILE)
        assertEquals(ColorRole.RELIEF, d.fill)
        assertEquals(ColorRole.OUTLINE, d.outline)
        assertEquals(ColorRole.INK_MUTED, d.glyph)
    }

    @Test
    fun idleDeviceIsReliefWithInk() {
        val d = MapVisuals.device(MapState.IDLE)
        assertEquals(ColorRole.RELIEF, d.fill)
        assertEquals(ColorRole.OUTLINE, d.outline)
        assertEquals(ColorRole.INK, d.glyph)
    }

    @Test
    fun connectingAndWaitingDeviceIsSignal() {
        for (state in listOf(MapState.CONNECTING, MapState.WAITING)) {
            val d = MapVisuals.device(state)
            assertEquals(ColorRole.SIGNAL, d.fill)
            assertEquals(ColorRole.SIGNAL, d.outline)
            assertEquals(ColorRole.ON_SIGNAL, d.glyph)
        }
    }

    @Test
    fun protectedDeviceIsConnected() {
        val d = MapVisuals.device(MapState.PROTECTED)
        assertEquals(ColorRole.CONNECTED, d.fill)
        assertEquals(ColorRole.CONNECTED, d.outline)
        assertEquals(ColorRole.ON_CONNECTED, d.glyph)
    }

    @Test
    fun staleDeviceHasAnAlarmOutlineAndGlyph() {
        val d = MapVisuals.device(MapState.STALE)
        assertEquals(ColorRole.RELIEF, d.fill)
        assertEquals(ColorRole.ALARM, d.outline)
        assertEquals(ColorRole.ALARM, d.glyph)
    }

    @Test
    fun disconnectingDeviceIsReliefWithMutedGlyph() {
        val d = MapVisuals.device(MapState.DISCONNECTING)
        assertEquals(ColorRole.RELIEF, d.fill)
        assertEquals(ColorRole.OUTLINE, d.outline)
        assertEquals(ColorRole.INK_MUTED, d.glyph)
    }

    @Test
    fun errorDeviceHasAnAlarmOutlineAndGlyph() {
        val d = MapVisuals.device(MapState.ERROR)
        assertEquals(ColorRole.RELIEF, d.fill)
        assertEquals(ColorRole.ALARM, d.outline)
        assertEquals(ColorRole.ALARM, d.glyph)
    }

    // Orbit ring

    @Test
    fun noProfileHasNoRing() {
        assertNull(MapVisuals.ring(MapState.NO_PROFILE))
    }

    @Test
    fun idleAndConnectingRingsAreDashedVariantLines() {
        for (state in listOf(MapState.IDLE, MapState.CONNECTING)) {
            val ring = MapVisuals.ring(state)!!
            assertEquals(ColorRole.OUTLINE_VARIANT, ring.role)
            assertTrue(ring.dashed)
        }
    }

    @Test
    fun waitingRingIsSolidVariantLine() {
        val ring = MapVisuals.ring(MapState.WAITING)!!
        assertEquals(ColorRole.OUTLINE_VARIANT, ring.role)
        assertFalse(ring.dashed)
    }

    @Test
    fun protectedRingIsConnectedAtFortyPercentSolid() {
        val ring = MapVisuals.ring(MapState.PROTECTED)!!
        assertEquals(ColorRole.CONNECTED, ring.role)
        near(0.4f, ring.alpha)
        assertFalse(ring.dashed)
    }

    @Test
    fun staleRingIsSolidVariantLine() {
        val ring = MapVisuals.ring(MapState.STALE)!!
        assertEquals(ColorRole.OUTLINE_VARIANT, ring.role)
        assertFalse(ring.dashed)
    }

    @Test
    fun disconnectingAndErrorRingsAreDashedVariantLines() {
        for (state in listOf(MapState.DISCONNECTING, MapState.ERROR)) {
            val ring = MapVisuals.ring(state)!!
            assertEquals(ColorRole.OUTLINE_VARIANT, ring.role)
            assertTrue(ring.dashed)
        }
    }

    // Peer node and its spoke

    @Test
    fun idlePeerIsReliefWithOutlineStrokeAndDashedSpoke() {
        val p = MapVisuals.peer(MapState.IDLE, responded = false)
        assertEquals(ColorRole.RELIEF, p.fill)
        assertEquals(ColorRole.OUTLINE, p.stroke.role)
        assertEquals(ColorRole.OUTLINE_VARIANT, p.spoke.role)
        assertTrue(p.spoke.dashed)
    }

    @Test
    fun connectingPeerHasSignalStrokeAtSixtyPercentDashedAndSpokeAtFortyPercent() {
        val p = MapVisuals.peer(MapState.CONNECTING, responded = false)
        assertNull(p.fill)
        assertEquals(ColorRole.SIGNAL, p.stroke.role)
        near(0.6f, p.stroke.alpha)
        assertTrue(p.stroke.dashed)
        assertEquals(ColorRole.SIGNAL, p.spoke.role)
        near(0.4f, p.spoke.alpha)
        assertTrue(p.spoke.dashed)
    }

    @Test
    fun waitingRespondedPeerIsSignalFillAndSolidSpoke() {
        val p = MapVisuals.peer(MapState.WAITING, responded = true)
        assertEquals(ColorRole.SIGNAL, p.fill)
        assertEquals(ColorRole.SIGNAL, p.stroke.role)
        assertEquals(ColorRole.SIGNAL, p.spoke.role)
        assertFalse(p.spoke.dashed)
    }

    @Test
    fun waitingSilentPeerIsDashedSignalLikeConnecting() {
        val p = MapVisuals.peer(MapState.WAITING, responded = false)
        assertNull(p.fill)
        assertEquals(ColorRole.SIGNAL, p.stroke.role)
        assertTrue(p.stroke.dashed)
    }

    @Test
    fun protectedRespondedPeerIsConnected() {
        val p = MapVisuals.peer(MapState.PROTECTED, responded = true)
        assertEquals(ColorRole.CONNECTED, p.fill)
        assertEquals(ColorRole.CONNECTED, p.stroke.role)
        assertEquals(ColorRole.CONNECTED, p.spoke.role)
        assertFalse(p.spoke.dashed)
    }

    @Test
    fun protectedSilentPeerIsOutlineWithDashedVariantSpoke() {
        val p = MapVisuals.peer(MapState.PROTECTED, responded = false)
        assertEquals(ColorRole.OUTLINE, p.stroke.role)
        assertEquals(ColorRole.OUTLINE_VARIANT, p.spoke.role)
        assertTrue(p.spoke.dashed)
    }

    @Test
    fun staleSilentPeerIsDashedAlarm() {
        val p = MapVisuals.peer(MapState.STALE, responded = false)
        assertEquals(ColorRole.ALARM, p.stroke.role)
        assertTrue(p.stroke.dashed)
        assertEquals(ColorRole.ALARM, p.spoke.role)
        assertTrue(p.spoke.dashed)
    }

    @Test
    fun disconnectingPeerHasOutlineStroke() {
        assertEquals(ColorRole.OUTLINE, MapVisuals.peer(MapState.DISCONNECTING, responded = false).stroke.role)
    }

    @Test
    fun errorPeerHasDashedOutlineStroke() {
        val p = MapVisuals.peer(MapState.ERROR, responded = false)
        assertEquals(ColorRole.OUTLINE, p.stroke.role)
        assertTrue(p.stroke.dashed)
    }

    // Organisation node

    @Test
    fun idleOrganisationIsDashedVariantWithoutFill() {
        val o = MapVisuals.org(MapState.IDLE, gatewayResponded = false)
        assertEquals(ColorRole.OUTLINE_VARIANT, o.stroke.role)
        assertTrue(o.stroke.dashed)
        assertNull(o.fill)
    }

    @Test
    fun waitingOrganisationIsSignalWhenGatewayResponded() {
        val o = MapVisuals.org(MapState.WAITING, gatewayResponded = true)
        assertEquals(ColorRole.SIGNAL, o.stroke.role)
        assertFalse(o.stroke.dashed)
    }

    @Test
    fun waitingOrganisationIsDashedVariantWhenGatewayIsSilent() {
        val o = MapVisuals.org(MapState.WAITING, gatewayResponded = false)
        assertEquals(ColorRole.OUTLINE_VARIANT, o.stroke.role)
        assertTrue(o.stroke.dashed)
    }

    @Test
    fun protectedOrganisationIsConnectedWithTwelvePercentFill() {
        val o = MapVisuals.org(MapState.PROTECTED, gatewayResponded = true)
        assertEquals(ColorRole.CONNECTED, o.stroke.role)
        assertEquals(ColorRole.CONNECTED, o.fill)
        near(0.12f, o.fillAlpha)
    }

    @Test
    fun staleDisconnectingAndErrorOrganisationsAreDashedVariant() {
        for (state in listOf(MapState.STALE, MapState.DISCONNECTING, MapState.ERROR)) {
            val o = MapVisuals.org(state, gatewayResponded = false)
            assertEquals(ColorRole.OUTLINE_VARIANT, o.stroke.role)
            assertTrue(o.stroke.dashed)
        }
    }

    // Cross-cutting rules

    @Test
    fun greenOnlyWhenProtected() {
        for (state in MapState.entries) {
            if (state == MapState.PROTECTED) continue
            for (responded in listOf(true, false)) {
                val d = MapVisuals.device(state)
                val r = MapVisuals.ring(state)
                val p = MapVisuals.peer(state, responded)
                val o = MapVisuals.org(state, responded)
                val roles = listOfNotNull(
                    d.fill, d.outline, d.glyph, r?.role, p.fill, p.stroke.role, p.spoke.role,
                    o.stroke.role, o.fill,
                )
                assertFalse("$state green", roles.any { it == ColorRole.CONNECTED || it == ColorRole.ON_CONNECTED })
            }
        }
    }

    @Test
    fun pulseOnlyWhileConnectingOrWaiting() {
        for (state in MapState.entries) {
            val expected = state == MapState.CONNECTING || state == MapState.WAITING
            assertEquals("$state", expected, MapVisuals.pulseEnabled(state, reducedMotion = false))
        }
    }

    @Test
    fun noPulseWithReducedMotion() {
        for (state in MapState.entries) {
            assertFalse("$state", MapVisuals.pulseEnabled(state, reducedMotion = true))
        }
    }
}
