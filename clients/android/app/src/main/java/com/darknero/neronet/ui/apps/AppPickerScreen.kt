package com.darknero.neronet.ui.apps

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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.darknero.neronet.R
import com.darknero.neronet.tunnel.AppRuleMode
import com.darknero.neronet.tunnel.AppRules
import com.darknero.neronet.ui.theme.LocalNnPalette
import com.darknero.neronet.ui.theme.NnTextStyles

/**
 * Split tunnelling for one profile: a mode (all apps, only the picked apps, all except the picked apps) and,
 * for the last two, a searchable list of apps. [apps] is null while the list is loading. Every row is at
 * least 48 dp tall and says its state in words through the radio or check box role.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AppPickerScreen(
    apps: List<AppEntry>?,
    rules: AppRules,
    onRulesChange: (AppRules) -> Unit,
    onBack: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val palette = LocalNnPalette.current
    var query by rememberSaveable { mutableStateOf("") }
    val shown = apps?.let { filterApps(it, query) }.orEmpty()

    Column(modifier.fillMaxSize()) {
        if (onBack != null) {
            TopAppBar(
                title = { Text(stringResource(R.string.split_title)) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                    }
                },
            )
        }
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).selectableGroup()) {
            ModeRow(R.string.split_mode_all, rules.mode == AppRuleMode.ALL, "split_mode_all") {
                onRulesChange(rules.copy(mode = AppRuleMode.ALL))
            }
            ModeRow(R.string.split_mode_include, rules.mode == AppRuleMode.INCLUDE_ONLY, "split_mode_include") {
                onRulesChange(rules.copy(mode = AppRuleMode.INCLUDE_ONLY))
            }
            ModeRow(R.string.split_mode_exclude, rules.mode == AppRuleMode.EXCLUDE, "split_mode_exclude") {
                onRulesChange(rules.copy(mode = AppRuleMode.EXCLUDE))
            }
        }
        Text(
            stringResource(R.string.split_applies_next),
            style = MaterialTheme.typography.bodyMedium,
            color = palette.inkMuted,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
        )
        if (rules.mode == AppRuleMode.ALL) return@Column

        OutlinedTextField(
            value = query,
            onValueChange = { query = it },
            label = { Text(stringResource(R.string.split_search)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("split_search"),
        )
        if (rules.mode == AppRuleMode.INCLUDE_ONLY && rules.packages.isEmpty()) {
            Text(
                stringResource(R.string.split_empty_include),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
        }
        when {
            apps == null -> Text(stringResource(R.string.split_loading), modifier = Modifier.padding(16.dp))
            shown.isEmpty() -> Text(
                stringResource(R.string.split_no_match),
                modifier = Modifier.padding(16.dp).testTag("split_no_match"),
            )
            else -> LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
                items(shown, key = { it.packageName }) { app ->
                    val checked = app.packageName in rules.packages
                    Row(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 56.dp)
                            .toggleable(
                                value = checked,
                                role = Role.Checkbox,
                                onValueChange = { onRulesChange(toggled(rules, app.packageName)) },
                            )
                            .testTag("app_row_" + app.packageName)
                            .padding(horizontal = 16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = checked, onCheckedChange = null)
                        Spacer(Modifier.width(12.dp))
                        Column(Modifier.weight(1f)) {
                            Text(app.label, style = MaterialTheme.typography.bodyLarge)
                            Text(app.packageName, style = NnTextStyles.tabular, color = palette.inkMuted)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ModeRow(label: Int, selected: Boolean, tag: String, onClick: () -> Unit) {
    Row(
        Modifier
            .fillMaxWidth()
            .heightIn(min = 48.dp)
            .selectable(selected = selected, onClick = onClick, role = Role.RadioButton)
            .testTag(tag),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null)
        Spacer(Modifier.width(12.dp))
        Text(stringResource(label), style = MaterialTheme.typography.bodyLarge)
    }
}
