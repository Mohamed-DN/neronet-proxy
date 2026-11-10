package com.darknero.neronet.ui.home

import androidx.compose.foundation.layout.heightIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.darknero.neronet.R

/** Top bar: the profile chip (phones only) opens Profiles; the gear opens Settings. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NeroNetTopBar(
    profileTitle: String?,
    showProfileChip: Boolean,
    onProfiles: () -> Unit,
    onSettings: () -> Unit,
) {
    TopAppBar(
        title = {
            Text(stringResource(R.string.app_name), style = MaterialTheme.typography.titleLarge)
        },
        actions = {
            if (showProfileChip && profileTitle != null) {
                val chipLabel = stringResource(R.string.profile_chip_label, profileTitle)
                TextButton(
                    onClick = onProfiles,
                    modifier = Modifier
                        .heightIn(min = 48.dp)
                        .semantics { contentDescription = chipLabel },
                ) {
                    Text(profileTitle, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Icon(Icons.Filled.ArrowDropDown, contentDescription = null)
                }
            }
            IconButton(onClick = onSettings) {
                Icon(Icons.Filled.Settings, contentDescription = stringResource(R.string.action_settings))
            }
        },
    )
}
