package com.darknero.neronet.system

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.darknero.neronet.NeroNetApplication

/** Handles the notification's Disconnect action by disconnecting the tunnel. */
class DisconnectReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ConnectionNotifier.ACTION_DISCONNECT) {
            NeroNetApplication.from(context).tunnels.disconnect()
        }
    }
}
