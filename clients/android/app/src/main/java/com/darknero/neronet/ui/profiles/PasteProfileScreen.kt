package com.darknero.neronet.ui.profiles

import android.app.Activity
import android.content.ClipboardManager
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.view.WindowManager
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import com.darknero.neronet.ImportResult
import com.darknero.neronet.R

/**
 * Paste a profile. The private key is in this field, so the window is secure (no screenshots, no
 * recents preview) while the screen shows, and a clipboard copy of an imported profile is cleared.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PasteProfileScreen(
    result: ImportResult?,
    onImport: (String) -> Unit,
    onBack: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    // Not rememberSaveable: the private key must not be written into saved instance state.
    var text by remember { mutableStateOf("") }
    var submitted by remember { mutableStateOf<String?>(null) }

    DisposableEffect(Unit) {
        val window = context.findActivity()?.window
        window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        onDispose { window?.clearFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }

    LaunchedEffect(result) {
        val pasted = submitted
        if (result is ImportResult.Imported && pasted != null && Build.VERSION.SDK_INT >= 28) {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            val clip = clipboard?.primaryClip
            if (clip != null && clip.itemCount > 0 && clip.getItemAt(0).text?.toString() == pasted) {
                clipboard?.clearPrimaryClip()
            }
        }
    }

    val message = result?.let { importResultMessage(it) }
    val isError = result is ImportResult.Invalid || result == ImportResult.TooLarge || result == ImportResult.NotAProfile
    val supporting: (@Composable () -> Unit)? =
        if (isError && message != null) ({ Text(message) }) else null

    Column(modifier.fillMaxSize()) {
        TopAppBar(
            title = { Text(stringResource(R.string.paste_title)) },
            navigationIcon = {
                IconButton(onClick = onBack) {
                    Icon(Icons.Filled.ArrowBack, contentDescription = stringResource(R.string.action_back))
                }
            },
        )
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(16.dp)) {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                modifier = Modifier.fillMaxWidth().testTag("paste_field"),
                label = { Text(stringResource(R.string.paste_field_label)) },
                placeholder = { Text(stringResource(R.string.paste_hint)) },
                textStyle = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                minLines = 8,
                isError = isError,
                supportingText = supporting,
            )
            Button(
                onClick = {
                    submitted = text
                    onImport(text)
                },
                enabled = text.isNotBlank(),
                modifier = Modifier.padding(top = 16.dp).heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.action_import))
            }
        }
    }
}

/** The sentence shown under the paste field or as the snackbar after an import attempt. */
@Composable
fun importResultMessage(result: ImportResult): String? = when (result) {
    is ImportResult.Imported -> stringResource(R.string.imported)
    is ImportResult.Duplicate -> stringResource(R.string.import_duplicate, result.title)
    is ImportResult.Invalid -> stringResource(R.string.import_failed, stringResource(result.reasonRes))
    ImportResult.TooLarge -> stringResource(R.string.read_failed)
    ImportResult.NotAProfile -> stringResource(R.string.qr_not_profile)
}

private fun Context.findActivity(): Activity? = when (this) {
    is Activity -> this
    is ContextWrapper -> baseContext.findActivity()
    else -> null
}
