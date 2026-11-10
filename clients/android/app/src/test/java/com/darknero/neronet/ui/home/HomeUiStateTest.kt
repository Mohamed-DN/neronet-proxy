package com.darknero.neronet.ui.home

import com.darknero.neronet.PeerSummary
import com.darknero.neronet.ProfileSummary
import com.darknero.neronet.R
import com.darknero.neronet.tunnel.MachineState
import com.darknero.neronet.tunnel.TunnelError
import com.darknero.neronet.tunnel.TunnelPhase
import com.darknero.neronet.tunnel.TunnelStats
import com.darknero.neronet.ui.UiText
import com.darknero.neronet.ui.map.MapState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class HomeUiStateTest {

    private val nowElapsed = 1_000_000L
    private val nowWall = 1_700_000_000_000L + nowElapsed

    private val peerKey = "PEERKEY"

    private val profile = ProfileSummary(
        id = "p1",
        title = "Office",
        deviceId = "laptop-7",
        addresses = listOf("100.64.12.34"),
        dns = listOf("100.64.0.53"),
        consoleUrl = "https://console.example",
        peers = listOf(
            PeerSummary(
                publicKey = peerKey,
                endpointHost = "gateway.example",
                endpointPort = 51820,
                allowedIps = listOf("100.64.0.0/10"),
                keepaliveSeconds = 25,
            ),
        ),
        devicePublicKey = "DEVKEY",
    )

    private fun build(
        phase: TunnelPhase,
        summary: ProfileSummary? = profile,
        hasProfiles: Boolean = true,
        stats: TunnelStats? = null,
        elapsed: Long = nowElapsed,
    ) = buildHomeUiState(
        machine = MachineState(phase, wantConnected = phase !is TunnelPhase.Disconnected),
        profile = summary,
        hasProfiles = hasProfiles,
        stats = stats,
        nowElapsedMs = elapsed,
        nowWallMs = nowWall,
    )

    /** A stats snapshot whose gateway last replied [agoMs] ago, or never when null. */
    private fun statsWithHandshake(agoMs: Long?) = TunnelStats(
        rxBytes = 4_096,
        txBytes = 1_024,
        lastHandshakeWallMs = mapOf(peerKey to (agoMs?.let { nowWall - it } ?: 0L)),
    )

    private fun connectedSince(agoMs: Long) = TunnelPhase.Connected("p1", nowElapsed - agoMs)

    private fun HomeUiState.titleId(): Int = (title as UiText.Res).id

    @Test
    fun noProfileRow() {
        val state = build(TunnelPhase.Disconnected, summary = null, hasProfiles = false)

        assertEquals(MapState.NO_PROFILE, state.mapState)
        assertEquals(R.string.status_no_profile_title, state.titleId())
        assertEquals(R.string.status_no_profile_line, (state.line as UiText.Res).id)
        assertNull(state.elapsed)
        assertEquals(StatusTone.NEUTRAL, state.tone)
        assertFalse(state.switchOn)
        assertFalse(state.switchEnabled)
    }

    @Test
    fun idleRow() {
        val state = build(TunnelPhase.Disconnected)

        assertEquals(MapState.IDLE, state.mapState)
        assertEquals(R.string.status_idle_title, state.titleId())
        assertEquals(R.string.status_idle_line, (state.line as UiText.Res).id)
        assertNull(state.elapsed)
        assertEquals(StatusTone.NEUTRAL, state.tone)
        assertFalse(state.switchOn)
        assertTrue(state.switchEnabled)
    }

    @Test
    fun connectingRowBeforeCancelIsUnavailable() {
        val state = build(TunnelPhase.Connecting("p1", nowElapsed - 1_000))

        assertEquals(MapState.CONNECTING, state.mapState)
        assertEquals(R.string.status_connecting_title, state.titleId())
        assertEquals(R.string.status_connecting_line, (state.line as UiText.Res).id)
        assertNull(state.elapsed)
        assertEquals(StatusTone.SIGNAL, state.tone)
        assertTrue(state.switchOn)
        assertFalse(state.switchEnabled)
    }

    @Test
    fun cancelAppearsAtTwoSeconds() {
        val early = build(TunnelPhase.Connecting("p1", nowElapsed - 1_999))
        val onTime = build(TunnelPhase.Connecting("p1", nowElapsed - 2_000))

        assertFalse(early.canCancel)
        assertFalse(early.switchEnabled)
        assertTrue(onTime.canCancel)
        assertTrue(onTime.switchEnabled)
    }

    @Test
    fun waitingRowWhenNoHandshakeYet() {
        val state = build(connectedSince(10_000), stats = statsWithHandshake(null))

        assertEquals(MapState.WAITING, state.mapState)
        assertEquals(R.string.status_waiting_title, state.titleId())
        assertEquals(R.string.status_waiting_line, (state.line as UiText.Res).id)
        assertNull(state.elapsed)
        assertEquals(StatusTone.SIGNAL, state.tone)
        assertTrue(state.switchOn)
        assertTrue(state.switchEnabled)
    }

    @Test
    fun protectedRowWithFreshHandshake() {
        val state = build(connectedSince(10_000), stats = statsWithHandshake(10_000))

        assertEquals(MapState.PROTECTED, state.mapState)
        assertEquals(R.string.status_protected_title, state.titleId())
        assertEquals(R.string.status_protected_line, (state.line as UiText.Res).id)
        assertEquals(R.string.elapsed_less_than_minute, (state.elapsed as UiText.Res).id)
        assertEquals(StatusTone.CONNECTED, state.tone)
        assertTrue(state.switchOn)
        assertTrue(state.switchEnabled)
    }

    @Test
    fun staleRowWithAHandshakeCarriesTheAge() {
        val state = build(connectedSince(600_000), stats = statsWithHandshake(200_000))

        assertEquals(MapState.STALE, state.mapState)
        assertEquals(R.string.status_stale_title, state.titleId())
        assertEquals(R.string.status_stale_line, (state.line as UiText.Res).id)
        assertNull(state.elapsed)
        assertEquals(StatusTone.ALARM, state.tone)
        assertTrue(state.switchOn)
        assertTrue(state.switchEnabled)
    }

    @Test
    fun staleRowNeverHadAHandshake() {
        val state = build(connectedSince(60_000), stats = statsWithHandshake(null))

        assertEquals(MapState.STALE, state.mapState)
        assertEquals(R.string.status_stale_never_line, (state.line as UiText.Res).id)
        assertEquals(StatusTone.ALARM, state.tone)
    }

    @Test
    fun disconnectingRow() {
        val state = build(TunnelPhase.Disconnecting("p1", nowElapsed))

        assertEquals(MapState.DISCONNECTING, state.mapState)
        assertEquals(R.string.status_disconnecting_title, state.titleId())
        assertNull(state.line)
        assertEquals(StatusTone.NEUTRAL, state.tone)
        assertFalse(state.switchOn)
        assertFalse(state.switchEnabled)
    }

    @Test
    fun errorRowOffersRetry() {
        val state = build(TunnelPhase.Error(TunnelError.TIMEOUT, "p1"))

        assertEquals(MapState.ERROR, state.mapState)
        assertEquals(R.string.status_error_title, state.titleId())
        assertNull(state.line)
        assertEquals(StatusTone.ALARM, state.tone)
        assertFalse(state.switchOn)
        assertTrue(state.switchEnabled)
        assertEquals(R.string.error_timeout, (state.error as UiText.Res).id)
        assertEquals(ErrorAction.RETRY, state.errorAction)
    }

    @Test
    fun greenToneOnlyWhenHandshakeFresh() {
        val fresh = build(connectedSince(10_000), stats = statsWithHandshake(10_000))
        val old = build(connectedSince(600_000), stats = statsWithHandshake(200_000))

        assertEquals(StatusTone.CONNECTED, fresh.tone)
        assertNotEquals(StatusTone.CONNECTED, old.tone)
    }

    @Test
    fun everyTunnelErrorMapsToItsSentenceAndAction() {
        val expected = mapOf(
            TunnelError.VPN_PERMISSION_DENIED to Pair(R.string.error_permission_denied, ErrorAction.RETRY),
            TunnelError.VPN_REVOKED to Pair(R.string.error_revoked, ErrorAction.RETRY),
            TunnelError.TIMEOUT to Pair(R.string.error_timeout, ErrorAction.RETRY),
            TunnelError.UNABLE_TO_START_VPN to Pair(R.string.error_unable_to_start, ErrorAction.OPEN_VPN_SETTINGS),
            TunnelError.DNS_RESOLUTION_FAILURE to Pair(R.string.error_dns, ErrorAction.RETRY),
            TunnelError.TUN_CREATION_ERROR to Pair(R.string.error_tun, ErrorAction.RETRY),
            TunnelError.GO_ACTIVATION_ERROR to Pair(R.string.error_go, ErrorAction.ADD_PROFILE),
            TunnelError.PROFILE_MISSING to Pair(R.string.error_profile_missing, ErrorAction.CHOOSE_PROFILE),
            TunnelError.DISCONNECT_TIMEOUT to Pair(R.string.error_disconnect_timeout, ErrorAction.OPEN_VPN_SETTINGS),
            TunnelError.UNKNOWN to Pair(R.string.error_unknown, ErrorAction.RETRY),
        )
        assertEquals(TunnelError.values().toSet(), expected.keys)
        for ((reason, want) in expected) {
            val (text, action) = errorText(reason, UiText.Plain("gw"))
            assertEquals("for $reason", want.first, (text as UiText.Res).id)
            assertEquals("for $reason", want.second, action)
        }
    }

    @Test
    fun missingEndpointUsesGatewayFallbackText() {
        val noEndpoint = profile.copy(
            peers = listOf(profile.peers.single().copy(endpointHost = null, endpointPort = null)),
        )

        val state = build(connectedSince(10_000), summary = noEndpoint, stats = statsWithHandshake(null))

        val line = state.line as UiText.Res
        assertEquals(R.string.status_waiting_line, line.id)
        assertEquals(UiText.Res(R.string.map_label_gateway_fallback), line.args.single())
    }

    @Test
    fun detailsHideTrafficWhenNotConnected() {
        val idle = build(TunnelPhase.Disconnected)
        val connected = build(connectedSince(10_000), stats = statsWithHandshake(10_000))

        assertTrue(idle.details.none { it.label == R.string.details_received })
        assertTrue(idle.details.none { it.label == R.string.details_sent })
        assertTrue(connected.details.any { it.label == R.string.details_received })
        assertTrue(connected.details.any { it.label == R.string.details_sent })
    }

    @Test
    fun elapsedTextBoundaries() {
        assertEquals(UiText.Res(R.string.elapsed_less_than_minute), elapsedText(59_999))
        assertEquals(UiText.Plural(R.plurals.elapsed_minutes, 1), elapsedText(60_000))
        assertEquals(UiText.Plural(R.plurals.elapsed_hours, 1), elapsedText(3_600_000))
        assertEquals(UiText.Plural(R.plurals.elapsed_days, 1), elapsedText(86_400_000))
    }

    @Test
    fun handshakeAgoBoundaries() {
        assertEquals(UiText.Res(R.string.details_handshake_never), handshakeAgoText(null))
        assertEquals(UiText.Plural(R.plurals.details_seconds_ago, 59), handshakeAgoText(59_999))
        assertEquals(UiText.Plural(R.plurals.details_minutes_ago, 1), handshakeAgoText(60_000))
    }
}
