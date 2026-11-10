package com.darknero.neronet.ui.profiles

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.darknero.neronet.ProfileSummary
import com.darknero.neronet.R
import com.darknero.neronet.ui.theme.LocalNnPalette
import com.darknero.neronet.ui.theme.NnTextStyles

/**
 * The saved profiles. Rows are a radio group: the selected one is the profile the switch uses, and the
 * active one (connected or connecting) is labelled "In use" in words.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ProfilesScreen(
    profiles: List<ProfileSummary>,
    selectedId: String?,
    activeId: String?,
    onSelect: (String) -> Unit,
    onDelete: (String) -> Unit,
    onAdd: () -> Unit,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    var pending by remember { mutableStateOf<ProfileSummary?>(null) }

    Column(modifier.fillMaxSize()) {
        if (onBack != null) {
            TopAppBar(
                title = { Text(stringResource(R.string.profiles_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                },
            )
        } else {
            Text(
                stringResource(R.string.profiles_title),
                style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 8.dp),
            )
        }
        LazyColumn(Modifier.weight(1f).fillMaxWidth().selectableGroup()) {
            items(profiles, key = { it.id }) { profile ->
                ProfileRow(
                    profile = profile,
                    selected = profile.id == selectedId,
                    active = profile.id == activeId,
                    onSelect = { onSelect(profile.id) },
                    onDelete = { pending = profile },
                )
            }
        }
        TextButton(
            onClick = onAdd,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) {
            Text(stringResource(R.string.profiles_add))
        }
    }

    pending?.let { profile ->
        DeleteProfileDialog(
            title = profile.title,
            connected = profile.id == activeId,
            onConfirm = {
                pending = null
                onDelete(profile.id)
            },
            onDismiss = { pending = null },
        )
    }
}

@Composable
private fun ProfileRow(
    profile: ProfileSummary,
    selected: Boolean,
    active: Boolean,
    onSelect: () -> Unit,
    onDelete: () -> Unit,
) {
    val palette = LocalNnPalette.current
    var menuOpen by remember { mutableStateOf(false) }
    val detail = profile.deviceId ?: profile.addresses.firstOrNull()

    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier
                .weight(1f)
                .heightIn(min = 64.dp)
                .selectable(selected = selected, role = Role.RadioButton, onClick = onSelect)
                .testTag("profile_row_${profile.id}")
                .padding(start = 8.dp, end = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            RadioButton(selected = selected, onClick = null)
            Spacer(Modifier.width(8.dp))
            Column(Modifier.weight(1f)) {
                Text(profile.title, style = MaterialTheme.typography.bodyLarge)
                detail?.let {
                    Text(it, style = NnTextStyles.tabular, color = palette.inkMuted)
                }
            }
            if (active) {
                Text(
                    stringResource(R.string.profiles_in_use),
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.padding(start = 8.dp),
                )
            }
        }
        Box {
            IconButton(onClick = { menuOpen = true }) {
                Icon(
                    Icons.Filled.MoreVert,
                    contentDescription = stringResource(R.string.profiles_row_menu, profile.title),
                )
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                DropdownMenuItem(
                    text = { Text(stringResource(R.string.action_delete)) },
                    onClick = {
                        menuOpen = false
                        onDelete()
                    },
                )
            }
        }
    }
}
