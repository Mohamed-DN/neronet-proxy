package com.darknero.neronet.ui.home

import androidx.annotation.StringRes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.darknero.neronet.R
import com.darknero.neronet.ui.UiText
import com.darknero.neronet.ui.resolve
import com.darknero.neronet.ui.theme.LocalNnPalette
import com.darknero.neronet.ui.theme.NnPalette
import com.darknero.neronet.ui.theme.NnTextStyles

/**
 * The status in words. Title and line form one polite live region; the elapsed time sits outside it,
 * so the minute count is not announced. Errors are assertive and carry their action.
 */
@Composable
fun StatusSentence(
    state: HomeUiState,
    onCancel: () -> Unit,
    onErrorAction: (ErrorAction) -> Unit,
    onDismissError: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val palette = LocalNnPalette.current
    Column(modifier.fillMaxWidth()) {
        Column(
            Modifier
                .fillMaxWidth()
                .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite }
                .testTag("status"),
        ) {
            Text(
                state.title.resolve(),
                style = MaterialTheme.typography.headlineMedium,
                color = palette.toneColor(state.tone),
            )
            state.line?.let { line ->
                Text(line.resolve(), style = MaterialTheme.typography.bodyLarge, color = palette.ink)
            }
        }
        state.elapsed?.let { elapsed ->
            Text(elapsed.resolve(), style = NnTextStyles.tabular, color = palette.inkMuted)
        }
        if (state.canCancel) {
            TextButton(onClick = onCancel) { Text(stringResource(R.string.action_cancel)) }
        }
        state.error?.let { error ->
            ErrorBlock(
                message = error,
                action = state.errorAction,
                onErrorAction = onErrorAction,
                onDismissError = onDismissError,
                palette = palette,
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ErrorBlock(
    message: UiText,
    action: ErrorAction?,
    onErrorAction: (ErrorAction) -> Unit,
    onDismissError: () -> Unit,
    palette: NnPalette,
) {
    Column(
        Modifier
            .fillMaxWidth()
            .semantics { liveRegion = LiveRegionMode.Assertive }
            .testTag("status_error"),
    ) {
        Text(message.resolve(), style = MaterialTheme.typography.bodyLarge, color = palette.alarm)
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            action?.let { chosen ->
                TextButton(onClick = { onErrorAction(chosen) }) { Text(stringResource(chosen.labelRes())) }
            }
            TextButton(onClick = onDismissError) { Text(stringResource(R.string.action_dismiss)) }
        }
    }
}

private fun ErrorAction.labelRes(): Int = when (this) {
    ErrorAction.RETRY -> R.string.action_retry
    ErrorAction.OPEN_VPN_SETTINGS -> R.string.action_open_vpn_settings
    ErrorAction.CHOOSE_PROFILE -> R.string.action_choose_profile
    ErrorAction.ADD_PROFILE -> R.string.profiles_add
}

private fun NnPalette.toneColor(tone: StatusTone): Color = when (tone) {
    StatusTone.NEUTRAL -> ink
    StatusTone.SIGNAL -> signal
    StatusTone.CONNECTED -> connected
    StatusTone.ALARM -> alarm
}
