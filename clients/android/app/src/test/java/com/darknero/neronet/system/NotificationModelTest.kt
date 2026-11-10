package com.darknero.neronet.system

import com.darknero.neronet.ProfileSummary
import com.darknero.neronet.tunnel.TunnelError
import com.darknero.neronet.tunnel.TunnelPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class NotificationModelTest {

    private val profiles = listOf(
        ProfileSummary(
            id = "p1",
            title = "Office",
            deviceId = null,
            addresses = listOf("100.64.12.34"),
            dns = emptyList(),
            consoleUrl = null,
            peers = emptyList(),
            devicePublicKey = "DEVKEY",
        ),
    )

    @Test
    fun onlyConnectedShowsANotification() {
        val wall = 1_700_000_000_000L
        val others = listOf(
            TunnelPhase.Disconnected,
            TunnelPhase.Connecting("p1", 0),
            TunnelPhase.Disconnecting("p1", 0),
            TunnelPhase.Error(TunnelError.TIMEOUT, "p1"),
        )

        for (phase in others) {
            assertNull("for $phase", notificationModel(phase, profiles, wall))
        }
    }

    @Test
    fun connectedShowsTheProfileTitleAndTheConnectionTime() {
        val wall = 1_700_000_000_000L

        val model = notificationModel(TunnelPhase.Connected("p1", 0), profiles, wall)

        assertEquals(NotificationModel("Office", wall), model)
    }
}
