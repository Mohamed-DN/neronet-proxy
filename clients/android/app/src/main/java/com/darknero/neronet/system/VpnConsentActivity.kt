package com.darknero.neronet.system

import android.app.Activity
import android.content.ComponentName
import android.net.VpnService
import android.os.Bundle
import android.service.quicksettings.TileService
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import com.darknero.neronet.NeroNetApplication

/**
 * A transparent screen that asks Android for VPN permission when the tile needs it. The tile cannot
 * show that dialog itself, so it starts this activity, which connects when the user agrees and reports
 * a refusal to the tunnel repository.
 */
class VpnConsentActivity : ComponentActivity() {

    private val consent = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val app = NeroNetApplication.from(this)
        val id = lastProfile()
        if (result.resultCode == Activity.RESULT_OK) {
            id?.let { app.tunnels.connect(it) }
        } else {
            app.tunnels.permissionDenied(id)
        }
        finishAndRefreshTile()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prepare = VpnService.prepare(this)
        if (prepare == null) {
            lastProfile()?.let { NeroNetApplication.from(this).tunnels.connect(it) }
            finishAndRefreshTile()
        } else {
            consent.launch(prepare)
        }
    }

    private fun lastProfile(): String? {
        val app = NeroNetApplication.from(this)
        return app.settings.lastProfileId ?: app.profiles.selectedId.value
    }

    private fun finishAndRefreshTile() {
        TileService.requestListeningState(this, ComponentName(this, NeroNetTileService::class.java))
        finish()
    }
}
