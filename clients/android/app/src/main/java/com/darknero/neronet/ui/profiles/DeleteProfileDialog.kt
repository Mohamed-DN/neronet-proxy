package com.darknero.neronet.ui.profiles

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import com.darknero.neronet.R

/** Confirmed delete. The connected wording says the connection closes first. */
@Composable
fun DeleteProfileDialog(
    title: String,
    connected: Boolean,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.delete_title, title)) },
        text = { Text(stringResource(if (connected) R.string.delete_message_connected else R.string.delete_message)) },
        confirmButton = {
            TextButton(onClick = onConfirm, modifier = Modifier.testTag("delete_confirm")) {
                Text(stringResource(R.string.action_delete), color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.action_cancel)) }
        },
    )
}
