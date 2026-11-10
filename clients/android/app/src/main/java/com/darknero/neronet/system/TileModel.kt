package com.darknero.neronet.system

import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import com.darknero.neronet.R
import com.darknero.neronet.tunnel.MachineState
import com.darknero.neronet.tunnel.TunnelPhase

enum class TileStateKind { ACTIVE, INACTIVE, UNAVAILABLE }

data class TileModel(
    val kind: TileStateKind,
    @StringRes val subtitle: Int,
    @DrawableRes val icon: Int,
)

/** What a tap on the tile does. */
enum class TileAction { OPEN_APP, DISCONNECT, REQUEST_CONSENT, CONNECT }

/** The tile's look: active while the user wants the tunnel up, off with a slashed icon otherwise. */
fun tileModel(machine: MachineState, hasProfiles: Boolean): TileModel = when {
    !hasProfiles -> TileModel(TileStateKind.UNAVAILABLE, R.string.tile_no_profile, R.drawable.ic_tile_off)
    else -> when (machine.phase) {
        is TunnelPhase.Connected -> TileModel(TileStateKind.ACTIVE, R.string.tile_connected, R.drawable.ic_tile)
        is TunnelPhase.Connecting -> TileModel(TileStateKind.ACTIVE, R.string.status_connecting_title, R.drawable.ic_tile)
        is TunnelPhase.Disconnecting ->
            TileModel(TileStateKind.INACTIVE, R.string.status_disconnecting_title, R.drawable.ic_tile_off)
        is TunnelPhase.Error -> TileModel(TileStateKind.INACTIVE, R.string.status_error_title, R.drawable.ic_tile_off)
        TunnelPhase.Disconnected -> TileModel(TileStateKind.INACTIVE, R.string.status_idle_title, R.drawable.ic_tile_off)
    }
}

fun tileAction(machine: MachineState, hasProfiles: Boolean, needsConsent: Boolean): TileAction = when {
    !hasProfiles -> TileAction.OPEN_APP
    machine.wantConnected -> TileAction.DISCONNECT
    needsConsent -> TileAction.REQUEST_CONSENT
    else -> TileAction.CONNECT
}
