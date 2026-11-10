package com.darknero.neronet.ui.home

import androidx.annotation.StringRes
import com.darknero.neronet.PeerSummary
import com.darknero.neronet.ProfileSummary
import com.darknero.neronet.R
import com.darknero.neronet.tunnel.LinkHealth
import com.darknero.neronet.tunnel.MachineState
import com.darknero.neronet.tunnel.TunnelError
import com.darknero.neronet.tunnel.TunnelPhase
import com.darknero.neronet.tunnel.TunnelStateMachine
import com.darknero.neronet.tunnel.TunnelStats
import com.darknero.neronet.tunnel.TunnelTimings
import com.darknero.neronet.tunnel.linkHealth
import com.darknero.neronet.ui.UiText
import com.darknero.neronet.ui.map.MapState
import com.darknero.neronet.ui.map.MapTopology

enum class StatusTone { NEUTRAL, SIGNAL, CONNECTED, ALARM }

enum class ErrorAction { RETRY, OPEN_VPN_SETTINGS, CHOOSE_PROFILE, ADD_PROFILE }

data class DetailRow(
    @StringRes val label: Int,
    val value: UiText,
    val copyValue: String? = null,
    val tabular: Boolean = false,
)

/** Everything the home screen shows, computed from the tunnel, the profile and the handshake. */
data class HomeUiState(
    val hasProfiles: Boolean,
    val profileTitle: String?,
    val mapState: MapState,
    val topology: MapTopology,
    val peerResponded: List<Boolean>,
    val mapDescription: UiText,
    val switchLabel: UiText,
    val gatewayLabel: UiText?,
    val networkLabel: UiText?,
    val networkCaption: String?,
    val switchOn: Boolean,
    val switchEnabled: Boolean,
    val canCancel: Boolean,
    val title: UiText,
    val line: UiText?,
    val elapsed: UiText?,
    val tone: StatusTone,
    val error: UiText?,
    val errorAction: ErrorAction?,
    val details: List<DetailRow>,
    val consoleUrl: String?,
)

/** One row of the plan's status table. */
private class StatusRow(
    val mapState: MapState,
    @StringRes val title: Int,
    val line: UiText?,
    val elapsed: UiText?,
    val tone: StatusTone,
    val switchOn: Boolean,
    val switchEnabled: Boolean,
    val canCancel: Boolean = false,
)

/**
 * Builds the home screen from what the tunnel and the profile report. Pure: the caller supplies the
 * clock readings and the latest traffic snapshot. A profile that is missing (and no error to show)
 * is the no-profile row.
 */
fun buildHomeUiState(
    machine: MachineState,
    profile: ProfileSummary?,
    hasProfiles: Boolean,
    stats: TunnelStats?,
    nowElapsedMs: Long,
    nowWallMs: Long,
): HomeUiState {
    val phase = machine.phase
    val peers = profile?.peers.orEmpty()
    val primary = peers.firstOrNull()
    val gw: UiText = endpointLabel(primary)
    val topology = topologyOf(profile)

    val ages = peers.associate { it.publicKey to handshakeAge(stats, it.publicKey, nowWallMs) }
    val latestAge = ages.values.filterNotNull().minOrNull()
    val keepaliveOn = peers.any { it.keepaliveSeconds > 0 }
    val peerResponded = peers.map { peer ->
        val age = ages[peer.publicKey]
        if (peer.keepaliveSeconds > 0) age != null && age <= TunnelTimings.HANDSHAKE_FRESH_MS else age != null
    }

    val noProfile = !hasProfiles || (profile == null && phase !is TunnelPhase.Error)
    val row = if (noProfile) {
        StatusRow(
            MapState.NO_PROFILE, R.string.status_no_profile_title,
            UiText.Res(R.string.status_no_profile_line), null, StatusTone.NEUTRAL,
            switchOn = false, switchEnabled = false,
        )
    } else {
        statusRow(phase, profile?.title.orEmpty(), gw, latestAge, keepaliveOn, nowElapsedMs)
    }

    val error = (phase as? TunnelPhase.Error)?.let { errorText(it.reason, gw) }

    return HomeUiState(
        hasProfiles = hasProfiles,
        profileTitle = profile?.title,
        mapState = row.mapState,
        topology = topology,
        peerResponded = peerResponded,
        mapDescription = mapDescription(topology, gw, primary),
        switchLabel = profile?.let { UiText.Res(R.string.map_switch_label, listOf(UiText.Plain(it.title))) }
            ?: UiText.Res(R.string.map_switch_label_no_profile),
        gatewayLabel = gatewayLabel(topology, primary),
        networkLabel = networkLabel(topology),
        networkCaption = (topology as? MapTopology.Gateway)?.takeUnless { it.fullTunnel }
            ?.let { primary?.allowedIps?.firstOrNull() },
        switchOn = row.switchOn,
        switchEnabled = row.switchEnabled,
        canCancel = row.canCancel,
        title = UiText.Res(row.title),
        line = row.line,
        elapsed = row.elapsed,
        tone = row.tone,
        error = error?.first,
        errorAction = error?.second,
        details = profile?.let { detailRows(it, phase is TunnelPhase.Connected, stats, latestAge) }.orEmpty(),
        consoleUrl = profile?.consoleUrl,
    )
}

private fun statusRow(
    phase: TunnelPhase,
    title: String,
    gw: UiText,
    latestAge: Long?,
    keepaliveOn: Boolean,
    nowElapsedMs: Long,
): StatusRow = when (phase) {
    TunnelPhase.Disconnected -> StatusRow(
        MapState.IDLE, R.string.status_idle_title,
        UiText.Res(R.string.status_idle_line, listOf(UiText.Plain(title))), null, StatusTone.NEUTRAL,
        switchOn = false, switchEnabled = true,
    )
    is TunnelPhase.Connecting -> {
        val cancellable = TunnelStateMachine.canCancel(phase, nowElapsedMs)
        StatusRow(
            MapState.CONNECTING, R.string.status_connecting_title,
            UiText.Res(R.string.status_connecting_line, listOf(gw)), null, StatusTone.SIGNAL,
            switchOn = true, switchEnabled = cancellable, canCancel = cancellable,
        )
    }
    is TunnelPhase.Connected -> when (linkHealth(nowElapsedMs - phase.sinceMs, latestAge, keepaliveOn)) {
        LinkHealth.WAITING -> StatusRow(
            MapState.WAITING, R.string.status_waiting_title,
            UiText.Res(R.string.status_waiting_line, listOf(gw)), null, StatusTone.SIGNAL,
            switchOn = true, switchEnabled = true,
        )
        LinkHealth.OK -> StatusRow(
            MapState.PROTECTED, R.string.status_protected_title,
            UiText.Res(R.string.status_protected_line, listOf(UiText.Plain(title))),
            elapsedText(nowElapsedMs - phase.sinceMs), StatusTone.CONNECTED,
            switchOn = true, switchEnabled = true,
        )
        LinkHealth.STALE -> StatusRow(
            MapState.STALE, R.string.status_stale_title,
            if (latestAge != null) {
                UiText.Res(R.string.status_stale_line, listOf(gw, durationText(latestAge)))
            } else {
                UiText.Res(R.string.status_stale_never_line, listOf(gw))
            },
            null, StatusTone.ALARM, switchOn = true, switchEnabled = true,
        )
    }
    is TunnelPhase.Disconnecting -> StatusRow(
        MapState.DISCONNECTING, R.string.status_disconnecting_title, null, null,
        StatusTone.NEUTRAL, switchOn = false, switchEnabled = false,
    )
    is TunnelPhase.Error -> StatusRow(
        MapState.ERROR, R.string.status_error_title, null, null, StatusTone.ALARM,
        switchOn = false, switchEnabled = true,
    )
}

/** The map's description and the plural counts of servers; see the copy in strings.xml. */
private fun mapDescription(topology: MapTopology, gw: UiText, primary: PeerSummary?): UiText = when (topology) {
    MapTopology.DeviceOnly -> UiText.Res(R.string.map_desc_device_only)
    is MapTopology.Gateway -> if (topology.fullTunnel) {
        UiText.Res(R.string.map_desc_gateway_full_tunnel, listOf(gw))
    } else {
        UiText.Res(R.string.map_desc_gateway, listOf(gw, UiText.Plain(primary?.allowedIps?.firstOrNull().orEmpty())))
    }
    is MapTopology.Servers -> UiText.Plural(R.plurals.map_desc_servers, topology.count)
}

private fun topologyOf(profile: ProfileSummary?): MapTopology = when {
    profile == null || profile.peers.isEmpty() -> MapTopology.DeviceOnly
    profile.peers.size == 1 -> MapTopology.Gateway(profile.isFullTunnel)
    else -> MapTopology.Servers(profile.peers.size)
}

private fun gatewayLabel(topology: MapTopology, primary: PeerSummary?): UiText? = when (topology) {
    MapTopology.DeviceOnly -> null
    else -> primary?.endpointHost?.let { UiText.Plain(it) } ?: UiText.Res(R.string.map_label_gateway_title)
}

private fun networkLabel(topology: MapTopology): UiText? = when (topology) {
    MapTopology.DeviceOnly -> null
    is MapTopology.Gateway ->
        if (topology.fullTunnel) UiText.Res(R.string.map_label_org_full_tunnel) else UiText.Res(R.string.map_label_org)
    is MapTopology.Servers -> null
}

private fun endpointLabel(peer: PeerSummary?): UiText =
    peer?.endpointHost?.let { UiText.Plain(it) } ?: UiText.Res(R.string.map_label_gateway_fallback)

/** Age of the peer's last handshake, or null when it never replied. */
private fun handshakeAge(stats: TunnelStats?, publicKey: String, nowWallMs: Long): Long? {
    val last = stats?.lastHandshakeWallMs?.get(publicKey) ?: return null
    return if (last > 0) nowWallMs - last else null
}

private fun detailRows(
    profile: ProfileSummary,
    connected: Boolean,
    stats: TunnelStats?,
    latestAge: Long?,
): List<DetailRow> = buildList {
    add(
        DetailRow(
            R.string.details_address,
            UiText.Plain(profile.addresses.joinToString(", ")),
            copyValue = profile.addresses.firstOrNull(),
            tabular = true,
        ),
    )
    add(DetailRow(R.string.details_gateway, gatewayDetail(profile.peers), tabular = true))
    add(
        DetailRow(
            R.string.details_network,
            UiText.Plain(profile.peers.flatMap { it.allowedIps }.distinct().joinToString(", ")),
            tabular = true,
        ),
    )
    if (profile.dns.isNotEmpty()) {
        add(DetailRow(R.string.details_dns, UiText.Plain(profile.dns.joinToString(", ")), tabular = true))
    }
    if (connected) {
        add(DetailRow(R.string.details_handshake, handshakeAgoText(latestAge)))
        if (stats != null) {
            add(DetailRow(R.string.details_received, UiText.Bytes(stats.rxBytes)))
            add(DetailRow(R.string.details_sent, UiText.Bytes(stats.txBytes)))
        }
    }
    profile.deviceId?.let { add(DetailRow(R.string.details_device_id, UiText.Plain(it))) }
}

private fun gatewayDetail(peers: List<PeerSummary>): UiText {
    val hosts = peers.mapNotNull { peer ->
        peer.endpointHost?.let { host -> peer.endpointPort?.let { "$host:$it" } ?: host }
    }
    return if (hosts.isEmpty()) UiText.Res(R.string.map_label_gateway_fallback) else UiText.Plain(hosts.joinToString(", "))
}

/** The sentence and the action for each tunnel error. */
fun errorText(reason: TunnelError, gateway: UiText): Pair<UiText, ErrorAction> = when (reason) {
    TunnelError.VPN_PERMISSION_DENIED -> UiText.Res(R.string.error_permission_denied) to ErrorAction.RETRY
    TunnelError.VPN_REVOKED -> UiText.Res(R.string.error_revoked) to ErrorAction.RETRY
    TunnelError.TIMEOUT -> UiText.Res(R.string.error_timeout) to ErrorAction.RETRY
    TunnelError.UNABLE_TO_START_VPN -> UiText.Res(R.string.error_unable_to_start) to ErrorAction.OPEN_VPN_SETTINGS
    TunnelError.DNS_RESOLUTION_FAILURE -> UiText.Res(R.string.error_dns, listOf(gateway)) to ErrorAction.RETRY
    TunnelError.TUN_CREATION_ERROR -> UiText.Res(R.string.error_tun) to ErrorAction.RETRY
    TunnelError.GO_ACTIVATION_ERROR -> UiText.Res(R.string.error_go) to ErrorAction.ADD_PROFILE
    TunnelError.PROFILE_MISSING -> UiText.Res(R.string.error_profile_missing) to ErrorAction.CHOOSE_PROFILE
    TunnelError.DISCONNECT_TIMEOUT -> UiText.Res(R.string.error_disconnect_timeout) to ErrorAction.OPEN_VPN_SETTINGS
    TunnelError.UNKNOWN -> UiText.Res(R.string.error_unknown) to ErrorAction.RETRY
}

/** "for 3 minutes" style text for how long a connection has been up. */
fun elapsedText(ms: Long): UiText = when {
    ms < 60_000 -> UiText.Res(R.string.elapsed_less_than_minute)
    ms < 3_600_000 -> UiText.Plural(R.plurals.elapsed_minutes, (ms / 60_000).toInt())
    ms < 86_400_000 -> UiText.Plural(R.plurals.elapsed_hours, (ms / 3_600_000).toInt())
    else -> UiText.Plural(R.plurals.elapsed_days, (ms / 86_400_000).toInt())
}

fun durationText(ms: Long): UiText = when {
    ms < 60_000 -> UiText.Res(R.string.duration_less_than_minute)
    ms < 3_600_000 -> UiText.Plural(R.plurals.duration_minutes, (ms / 60_000).toInt())
    else -> UiText.Plural(R.plurals.duration_hours, (ms / 3_600_000).toInt())
}

fun handshakeAgoText(ageMs: Long?): UiText = when {
    ageMs == null -> UiText.Res(R.string.details_handshake_never)
    ageMs < 60_000 -> UiText.Plural(R.plurals.details_seconds_ago, (ageMs / 1_000).toInt())
    else -> UiText.Plural(R.plurals.details_minutes_ago, (ageMs / 60_000).toInt())
}
