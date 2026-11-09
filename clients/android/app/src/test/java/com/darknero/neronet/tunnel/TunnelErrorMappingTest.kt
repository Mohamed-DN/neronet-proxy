package com.darknero.neronet.tunnel

import com.wireguard.android.backend.BackendException
import com.wireguard.android.backend.BackendException.Reason
import org.junit.Assert.assertEquals
import org.junit.Test

class TunnelErrorMappingTest {

    @Test
    fun notAuthorizedBecomesPermissionDenied() {
        assertEquals(TunnelError.VPN_PERMISSION_DENIED, tunnelErrorOf(BackendException(Reason.VPN_NOT_AUTHORIZED)))
    }

    @Test
    fun unableToStartKeepsItsName() {
        assertEquals(TunnelError.UNABLE_TO_START_VPN, tunnelErrorOf(BackendException(Reason.UNABLE_TO_START_VPN)))
    }

    @Test
    fun dnsFailureKeepsItsName() {
        assertEquals(TunnelError.DNS_RESOLUTION_FAILURE, tunnelErrorOf(BackendException(Reason.DNS_RESOLUTION_FAILURE)))
    }

    @Test
    fun tunCreationKeepsItsName() {
        assertEquals(TunnelError.TUN_CREATION_ERROR, tunnelErrorOf(BackendException(Reason.TUN_CREATION_ERROR)))
    }

    @Test
    fun goActivationBecomesGoActivationError() {
        assertEquals(TunnelError.GO_ACTIVATION_ERROR, tunnelErrorOf(BackendException(Reason.GO_ACTIVATION_ERROR_CODE)))
    }

    @Test
    fun missingConfigBecomesProfileMissing() {
        assertEquals(TunnelError.PROFILE_MISSING, tunnelErrorOf(BackendException(Reason.TUNNEL_MISSING_CONFIG)))
    }

    @Test
    fun otherBackendReasonsBecomeUnknown() {
        assertEquals(TunnelError.UNKNOWN, tunnelErrorOf(BackendException(Reason.WG_QUICK_CONFIG_ERROR_CODE)))
    }

    @Test
    fun nonBackendFailureBecomesUnknown() {
        assertEquals(TunnelError.UNKNOWN, tunnelErrorOf(IllegalStateException()))
    }
}
