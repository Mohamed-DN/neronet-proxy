package com.darknero.neronet.system

import android.content.Context
import android.content.Intent
import android.provider.Settings

/**
 * Opens the system VPN settings, where the user can make NeroNet the always-on VPN.
 * Returns false when this device has no screen for it.
 */
fun openVpnSettings(context: Context): Boolean {
    for (action in listOf(Settings.ACTION_VPN_SETTINGS, Settings.ACTION_WIRELESS_SETTINGS)) {
        val intent = Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (intent.resolveActivity(context.packageManager) != null) {
            context.startActivity(intent)
            return true
        }
    }
    return false
}
