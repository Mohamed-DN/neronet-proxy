package com.darknero.neronet.ui.home

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.darknero.neronet.AddMethod
import com.darknero.neronet.R
import com.darknero.neronet.ui.LayoutMode
import com.darknero.neronet.ui.map.MapTopology
import com.darknero.neronet.ui.map.NetworkMap
import com.darknero.neronet.ui.resolve

/** Map counts above this many servers draw one overflow node (see MapGeometry). */
private const val MAX_DRAWN_SERVERS = 6

/**
 * The home screen. Phones get one column (map, status, details or the empty state). Tablets in
 * landscape get two panes: the map and status on the left, profiles and details on the right.
 */
@Composable
fun HomeScreen(
    state: HomeUiState,
    layout: LayoutMode,
    onToggle: (Boolean) -> Unit,
    onCancel: () -> Unit,
    onErrorAction: (ErrorAction) -> Unit,
    onDismissError: () -> Unit,
    onOpenConsole: (String) -> Unit,
    onCopyAddress: (String) -> Unit,
    onAdd: (AddMethod) -> Unit,
    onProfiles: () -> Unit,
    onSettings: () -> Unit,
    secondaryPane: @Composable () -> Unit,
) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    val twoPane = layout == LayoutMode.TWO_PANE

    Scaffold(
        topBar = {
            NeroNetTopBar(
                profileTitle = state.profileTitle,
                showProfileChip = !twoPane && state.profileTitle != null,
                onProfiles = onProfiles,
                onSettings = onSettings,
            )
        },
    ) { padding ->
        if (twoPane) {
            Row(Modifier.padding(padding).padding(horizontal = 24.dp, vertical = 16.dp).fillMaxSize()) {
                Column(Modifier.weight(3f).fillMaxHeight()) {
                    MapAndStatus(
                        state = state,
                        onToggle = onToggle,
                        onCancel = onCancel,
                        onErrorAction = onErrorAction,
                        onDismissError = onDismissError,
                        modifier = Modifier.weight(1f).fillMaxWidth(),
                    )
                    if (!state.hasProfiles) EmptyState(onAdd, Modifier.padding(top = 16.dp))
                }
                Spacer(Modifier.width(24.dp))
                Column(Modifier.weight(2f).fillMaxHeight()) {
                    Column(Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())) {
                        secondaryPane()
                    }
                    DetailsPanel(
                        rows = state.details,
                        consoleUrl = state.consoleUrl,
                        expanded = true,
                        onExpandedChange = {},
                        alwaysExpanded = true,
                        onCopyAddress = onCopyAddress,
                        onOpenConsole = onOpenConsole,
                        modifier = Modifier.padding(top = 16.dp),
                    )
                }
            }
        } else {
            Column(Modifier.padding(padding).padding(horizontal = 16.dp, vertical = 8.dp).fillMaxSize()) {
                MapAndStatus(
                    state = state,
                    onToggle = onToggle,
                    onCancel = onCancel,
                    onErrorAction = onErrorAction,
                    onDismissError = onDismissError,
                    modifier = Modifier.weight(1f).fillMaxWidth(),
                )
                if (!state.hasProfiles) {
                    EmptyState(onAdd, Modifier.padding(bottom = 8.dp))
                } else {
                    DetailsPanel(
                        rows = state.details,
                        consoleUrl = state.consoleUrl,
                        expanded = expanded,
                        onExpandedChange = { expanded = it },
                        alwaysExpanded = false,
                        onCopyAddress = onCopyAddress,
                        onOpenConsole = onOpenConsole,
                    )
                }
            }
        }
    }
}

/** The network map (the switch) above the status sentence. */
@Composable
private fun MapAndStatus(
    state: HomeUiState,
    onToggle: (Boolean) -> Unit,
    onCancel: () -> Unit,
    onErrorAction: (ErrorAction) -> Unit,
    onDismissError: () -> Unit,
    modifier: Modifier,
) {
    Column(modifier, horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
            NetworkMap(
                state = state.mapState,
                topology = state.topology,
                peerResponded = state.peerResponded,
                pictureDescription = state.mapDescription.resolve(),
                switchLabel = state.switchLabel.resolve(),
                stateDescription = state.title.resolve(),
                switchOn = state.switchOn,
                switchEnabled = state.switchEnabled,
                onToggle = onToggle,
                deviceLabel = stringResource(R.string.map_label_this_device),
                gatewayLabel = state.gatewayLabel?.resolve(),
                networkLabel = state.networkLabel?.resolve(),
                networkCaption = state.networkCaption,
                overflowLabel = (state.topology as? MapTopology.Servers)
                    ?.takeIf { it.count > MAX_DRAWN_SERVERS }
                    ?.let { stringResource(R.string.map_overflow, it.count - (MAX_DRAWN_SERVERS - 1)) },
                modifier = Modifier.fillMaxSize(),
            )
        }
        StatusSentence(
            state = state,
            onCancel = onCancel,
            onErrorAction = onErrorAction,
            onDismissError = onDismissError,
            modifier = Modifier.padding(top = 8.dp),
        )
    }
}
