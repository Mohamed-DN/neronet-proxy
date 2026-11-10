package com.darknero.neronet.ui.settings

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.darknero.neronet.LicenseCatalog
import com.darknero.neronet.LicenseEntry
import com.darknero.neronet.R

/** The licence list. Tapping an entry shows its licence text from the app's assets. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun LicensesScreen(onBack: () -> Unit) {
    var openIndex by rememberSaveable { mutableStateOf(-1) }
    val open: LicenseEntry? = LicenseCatalog.ALL.getOrNull(openIndex)

    BackHandler(enabled = open != null) { openIndex = -1 }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(open?.name ?: stringResource(R.string.settings_licenses)) },
                navigationIcon = {
                    IconButton(onClick = { if (open != null) openIndex = -1 else onBack() }) {
                        Icon(
                            Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.action_back),
                        )
                    }
                },
            )
        },
    ) { padding ->
        if (open == null) {
            LazyColumn(Modifier.fillMaxSize().padding(padding)) {
                itemsIndexed(LicenseCatalog.ALL) { index, entry ->
                    Column(
                        Modifier
                            .fillMaxWidth()
                            .heightIn(min = 48.dp)
                            .clickable(role = Role.Button) { openIndex = index }
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                    ) {
                        Text(entry.name, style = MaterialTheme.typography.bodyLarge)
                        Text(entry.license, style = MaterialTheme.typography.bodyMedium)
                    }
                    HorizontalDivider()
                }
            }
        } else {
            LicenseText(open, Modifier.fillMaxSize().padding(padding))
        }
    }
}

@Composable
private fun LicenseText(entry: LicenseEntry, modifier: Modifier) {
    val context = LocalContext.current
    val text = remember(entry.asset) {
        context.assets.open("licenses/${entry.asset}").bufferedReader().use { it.readText() }
    }
    Text(
        text,
        fontFamily = FontFamily.Monospace,
        style = MaterialTheme.typography.bodySmall,
        modifier = modifier.verticalScroll(rememberScrollState()).padding(16.dp),
    )
}
