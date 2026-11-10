package com.darknero.neronet.system

import com.darknero.neronet.R
import com.darknero.neronet.tunnel.MachineState
import com.darknero.neronet.tunnel.TunnelError
import com.darknero.neronet.tunnel.TunnelPhase
import org.junit.Assert.assertEquals
import org.junit.Test

class TileModelTest {

    private fun machine(phase: TunnelPhase, wantConnected: Boolean) = MachineState(phase, wantConnected)

    @Test
    fun noProfileIsUnavailableWhateverThePhase() {
        val model = tileModel(machine(TunnelPhase.Disconnected, false), hasProfiles = false)

        assertEquals(TileModel(TileStateKind.UNAVAILABLE, R.string.tile_no_profile, R.drawable.ic_tile_off), model)
    }

    @Test
    fun connectedIsActive() {
        val model = tileModel(machine(TunnelPhase.Connected("p1", 0), true), hasProfiles = true)

        assertEquals(TileModel(TileStateKind.ACTIVE, R.string.tile_connected, R.drawable.ic_tile), model)
    }

    @Test
    fun connectingIsActive() {
        val model = tileModel(machine(TunnelPhase.Connecting("p1", 0), true), hasProfiles = true)

        assertEquals(TileModel(TileStateKind.ACTIVE, R.string.status_connecting_title, R.drawable.ic_tile), model)
    }

    @Test
    fun disconnectingIsInactiveWithSlashIcon() {
        val model = tileModel(machine(TunnelPhase.Disconnecting("p1", 0), false), hasProfiles = true)

        assertEquals(TileModel(TileStateKind.INACTIVE, R.string.status_disconnecting_title, R.drawable.ic_tile_off), model)
    }

    @Test
    fun errorIsInactive() {
        val model = tileModel(machine(TunnelPhase.Error(TunnelError.TIMEOUT, "p1"), false), hasProfiles = true)

        assertEquals(TileModel(TileStateKind.INACTIVE, R.string.status_error_title, R.drawable.ic_tile_off), model)
    }

    @Test
    fun disconnectedIsInactive() {
        val model = tileModel(machine(TunnelPhase.Disconnected, false), hasProfiles = true)

        assertEquals(TileModel(TileStateKind.INACTIVE, R.string.status_idle_title, R.drawable.ic_tile_off), model)
    }

    @Test
    fun noProfileOpensTheApp() {
        assertEquals(
            TileAction.OPEN_APP,
            tileAction(machine(TunnelPhase.Connected("p1", 0), true), hasProfiles = false, needsConsent = false),
        )
    }

    @Test
    fun wantConnectedDisconnects() {
        assertEquals(
            TileAction.DISCONNECT,
            tileAction(machine(TunnelPhase.Connected("p1", 0), true), hasProfiles = true, needsConsent = true),
        )
        assertEquals(
            TileAction.DISCONNECT,
            tileAction(machine(TunnelPhase.Connecting("p1", 0), true), hasProfiles = true, needsConsent = false),
        )
    }

    @Test
    fun missingConsentRequestsConsent() {
        assertEquals(
            TileAction.REQUEST_CONSENT,
            tileAction(machine(TunnelPhase.Disconnected, false), hasProfiles = true, needsConsent = true),
        )
    }

    @Test
    fun otherwiseConnects() {
        assertEquals(
            TileAction.CONNECT,
            tileAction(machine(TunnelPhase.Error(TunnelError.TIMEOUT, "p1"), false), hasProfiles = true, needsConsent = false),
        )
    }
}
