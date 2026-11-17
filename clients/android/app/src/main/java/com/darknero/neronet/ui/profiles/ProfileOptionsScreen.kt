package com.darknero.neronet.ui.profiles

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.darknero.neronet.ProfileSummary
import com.darknero.neronet.R
import com.darknero.neronet.ui.theme.LocalNnPalette

/**
 * Options kept on this device for one profile. They are never written into the profile file, which stays
 * a standard wg-quick file. Each option is a labelled row: the state is written as words, not only a colour.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfileOptionsScreen(
    profile: ProfileSummary,
    killSwitch: Boolean,
    onKillSwitchChange: (Boolean) -> Unit,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxSize()) {
        if (onBack != null) {
            TopAppBar(
                title = { Text(stringResource(R.string.options_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                },
            )
        } else {
            Text(
                stringResource(R.string.options_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 8.dp),
            )
        }
        Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(profile.title, style = MaterialTheme.typography.titleMedium)
            SwitchRow(
                title = stringResource(R.string.kill_switch_title),
                body = stringResource(R.string.kill_switch_body),
                checked = killSwitch,
                onCheckedChange = onKillSwitchChange,
                tag = "option_kill_switch",
            )
        }
    }
}

/** A labelled switch row, at least 56 dp tall; the whole row toggles and the state is also written out. */
@Composable
fun SwitchRow(
    title: String,
    body: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    tag: String,
) {
    val palette = LocalNnPalette.current
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 56.dp)
            .toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange)
            .testTag(tag)
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f).padding(end = 16.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge)
            Text(
                stringResource(if (checked) R.string.state_on else R.string.state_off),
                style = MaterialTheme.typography.labelLarge,
            )
            Text(body, style = MaterialTheme.typography.bodyMedium, color = palette.inkMuted)
        }
        Switch(checked = checked, onCheckedChange = null)
    }
}
