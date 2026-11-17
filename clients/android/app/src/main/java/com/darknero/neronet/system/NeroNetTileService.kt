package com.darknero.neronet.system

import android.app.PendingIntent
import android.content.Intent
import android.graphics.drawable.Icon
import android.net.VpnService
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.darknero.neronet.MainActivity
import com.darknero.neronet.NeroNetApplication
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

/**
 * The Quick Settings tile. It listens only while the shade is open, and every action on a locked
 * secure device waits for the user to unlock (someone holding the phone must not switch the VPN off).
 */
class NeroNetTileService : TileService() {

    private val scope = MainScope()
    private var listening: Job? = null

    override fun onStartListening() {
        super.onStartListening()
        val app = NeroNetApplication.from(this)
        listening = scope.launch {
            combine(app.tunnels.state, app.profiles.profiles) { machine, all ->
                tileModel(machine, all.isNotEmpty())
            }.collect { render(it) }
        }
    }

    override fun onStopListening() {
        listening?.cancel()
        listening = null
        super.onStopListening()
    }

    override fun onDestroy() {
        scope.cancel()
        super.onDestroy()
    }

    override fun onClick() {
        val app = NeroNetApplication.from(this)
        val action = tileAction(
            machine = app.tunnels.state.value,
            hasProfiles = app.profiles.profiles.value.isNotEmpty(),
            needsConsent = VpnService.prepare(this) != null,
        )
        if (isLocked && isSecure) {
            unlockAndRun { perform(action) }
        } else {
            perform(action)
        }
    }

    private fun perform(action: TileAction) {
        val app = NeroNetApplication.from(this)
        when (action) {
            TileAction.OPEN_APP -> openActivity(Intent(this, MainActivity::class.java))
            TileAction.DISCONNECT -> app.tunnels.disconnect()
            TileAction.REQUEST_CONSENT -> openActivity(Intent(this, VpnConsentActivity::class.java))
            TileAction.CONNECT -> {
                val id = app.settings.lastProfileId ?: app.profiles.selectedId.value ?: return
                app.tunnels.connect(id)
            }
        }
    }

    private fun openActivity(intent: Intent) {
        if (Build.VERSION.SDK_INT >= 34) {
            val pending = PendingIntent.getActivity(
                this,
                0,
                intent,
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
            startActivityAndCollapse(pending)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }

    private fun render(model: TileModel) {
        val tile = qsTile ?: return
        tile.state = when (model.kind) {
            TileStateKind.ACTIVE -> Tile.STATE_ACTIVE
            TileStateKind.INACTIVE -> Tile.STATE_INACTIVE
            TileStateKind.UNAVAILABLE -> Tile.STATE_UNAVAILABLE
        }
        tile.icon = Icon.createWithResource(this, model.icon)
        if (Build.VERSION.SDK_INT >= 29) tile.subtitle = getString(model.subtitle)
        tile.updateTile()
    }
}
