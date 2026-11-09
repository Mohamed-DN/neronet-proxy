package com.darknero.neronet.tunnel

import com.wireguard.android.backend.BackendException
import com.wireguard.android.backend.BackendException.Reason

/** Maps a failure from the WireGuard backend to the UI's error. Anything not named here is [TunnelError.UNKNOWN]. */
fun tunnelErrorOf(error: Throwable): TunnelError {
    if (error !is BackendException) return TunnelError.UNKNOWN
    return when (error.reason) {
        Reason.VPN_NOT_AUTHORIZED -> TunnelError.VPN_PERMISSION_DENIED
        Reason.UNABLE_TO_START_VPN -> TunnelError.UNABLE_TO_START_VPN
        Reason.DNS_RESOLUTION_FAILURE -> TunnelError.DNS_RESOLUTION_FAILURE
        Reason.TUN_CREATION_ERROR -> TunnelError.TUN_CREATION_ERROR
        Reason.GO_ACTIVATION_ERROR_CODE -> TunnelError.GO_ACTIVATION_ERROR
        Reason.TUNNEL_MISSING_CONFIG -> TunnelError.PROFILE_MISSING
        else -> TunnelError.UNKNOWN
    }
}
