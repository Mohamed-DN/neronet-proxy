package com.darknero.neronet.ui.home

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.spring
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.darknero.neronet.R
import com.darknero.neronet.ui.map.rememberReducedMotion
import com.darknero.neronet.ui.resolve
import com.darknero.neronet.ui.theme.LocalNnPalette
import com.darknero.neronet.ui.theme.NnTextStyles

/**
 * The quiet details panel: one toggle row (its label carries the state) and the rows below it.
 * In two-pane layout it is always expanded and has no toggle.
 */
@Composable
fun DetailsPanel(
    rows: List<DetailRow>,
    consoleUrl: String?,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    alwaysExpanded: Boolean,
    onCopyAddress: (String) -> Unit,
    onOpenConsole: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val reducedMotion = rememberReducedMotion()
    val open = alwaysExpanded || expanded
    Column(
        modifier
            .fillMaxWidth()
            .animateContentSize(animationSpec = if (reducedMotion) snap() else spring()),
    ) {
        if (!alwaysExpanded) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 56.dp)
                    .clickable(role = Role.Button) { onExpandedChange(!expanded) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    stringResource(if (expanded) R.string.details_hide else R.string.details_show),
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.weight(1f),
                )
                Icon(
                    if (expanded) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowUp,
                    contentDescription = null,
                )
            }
        }
        if (open) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState()),
            ) {
                rows.forEach { row -> DetailRowItem(row, onCopyAddress) }
                if (consoleUrl != null) {
                    OutlinedButton(
                        onClick = { onOpenConsole(consoleUrl) },
                        modifier = Modifier.padding(vertical = 8.dp).heightIn(min = 48.dp),
                    ) {
                        Text(stringResource(R.string.action_open_console))
                    }
                }
            }
        }
    }
}

@Composable
private fun DetailRowItem(row: DetailRow, onCopy: (String) -> Unit) {
    val palette = LocalNnPalette.current
    Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(
                stringResource(row.label),
                style = MaterialTheme.typography.labelMedium,
                color = palette.inkMuted,
            )
            Text(
                row.value.resolve(),
                style = if (row.tabular) NnTextStyles.tabular else MaterialTheme.typography.bodyMedium,
            )
        }
        row.copyValue?.let { address ->
            IconButton(onClick = { onCopy(address) }) {
                Icon(
                    painterResource(R.drawable.ic_copy),
                    contentDescription = stringResource(R.string.details_copy_address),
                )
            }
        }
    }
}
