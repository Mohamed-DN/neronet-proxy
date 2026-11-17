package com.darknero.neronet.ui.map

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class MapGeometryTest {

    private fun near(expected: Float, actual: Float) =
        assertEquals("expected $expected", expected.toDouble(), actual.toDouble(), 1e-4)

    private val allTopologies: List<MapTopology> = listOf(
        MapTopology.DeviceOnly,
        MapTopology.Gateway(fullTunnel = false),
        MapTopology.Gateway(fullTunnel = true),
    ) + (2..10).map { MapTopology.Servers(it) }

    @Test
    fun deviceOnlyHasNoRingNoPeers() {
        val layout = MapGeometry.layout(MapTopology.DeviceOnly)
        assertNull(layout.ringRadius)
        assertTrue(layout.peers.isEmpty())
        assertNull(layout.org)
        near(0.50f, layout.device.x)
        near(0.56f, layout.device.y)
        near(0.12f, layout.device.r)
    }

    @Test
    fun gatewayLayoutPutsThePeerAtTheTopOfTheRing() {
        val layout = MapGeometry.layout(MapTopology.Gateway(fullTunnel = false))
        near(0.27f, layout.ringRadius!!)
        assertEquals(1, layout.peers.size)
        near(0.50f, layout.peers[0].x)
        near(0.29f, layout.peers[0].y)
        near(0.045f, layout.peers[0].r)
    }

    @Test
    fun gatewayLayoutPutsTheOrganisationOnTheGatewaysRay() {
        val org = MapGeometry.layout(MapTopology.Gateway(fullTunnel = false)).org!!
        near(0.50f, org.x)
        near(0.12f, org.y)
        near(0.07f, org.r)
    }

    @Test
    fun fourServersAtRightAngles() {
        val peers = MapGeometry.layout(MapTopology.Servers(4)).peers
        assertEquals(4, peers.size)
        near(0.50f, peers[0].x); near(0.29f, peers[0].y)
        near(0.77f, peers[1].x); near(0.56f, peers[1].y)
        near(0.50f, peers[2].x); near(0.83f, peers[2].y)
        near(0.23f, peers[3].x); near(0.56f, peers[3].y)
    }

    @Test
    fun nineServersShowFiveAndOverflowFour() {
        val layout = MapGeometry.layout(MapTopology.Servers(9))
        assertEquals(6, layout.peers.size)
        assertEquals(4, layout.overflowCount)
    }

    @Test
    fun fewerThanSevenServersHaveNoOverflow() {
        assertEquals(0, MapGeometry.layout(MapTopology.Servers(6)).overflowCount)
        assertEquals(0, MapGeometry.layout(MapTopology.Servers(2)).overflowCount)
    }

    @Test
    fun everyNodeInsideTheSquare() {
        for (topology in allTopologies) {
            val layout = MapGeometry.layout(topology)
            val nodes = listOf(layout.device) + layout.peers + listOfNotNull(layout.org)
            for (node in nodes) {
                assertTrue("$topology: left edge", node.x - node.r >= 0f)
                assertTrue("$topology: right edge", node.x + node.r <= 1f)
                assertTrue("$topology: top edge", node.y - node.r >= 0f)
                assertTrue("$topology: bottom edge", node.y + node.r <= 1f)
            }
        }
    }

    @Test
    fun organisationDoesNotTouchTheGateway() {
        val layout = MapGeometry.layout(MapTopology.Gateway(fullTunnel = false))
        val gatewayTop = layout.peers[0].y - layout.peers[0].r
        val orgBottom = layout.org!!.y + layout.org.r
        assertTrue("gap ${gatewayTop - orgBottom}", gatewayTop - orgBottom >= 0.05f)
    }

    @Test
    fun touchTargetIsAtLeast48Dp() {
        for (size in listOf(120f, 240f, 480f)) {
            assertTrue("size $size", MapGeometry.touchTargetDp(size) >= 48f)
        }
    }

    @Test
    fun mapSizeClampsToTheRange() {
        near(480f, MapGeometry.mapSizeDp(1000f, 900f))
        near(300f, MapGeometry.mapSizeDp(300f, 800f))
        near(200f, MapGeometry.mapSizeDp(200f, 200f))
    }
}
