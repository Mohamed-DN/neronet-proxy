package com.darknero.neronet.ui.home

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.darknero.neronet.AddMethod
import com.darknero.neronet.R

/** The invitation shown when no profile exists: scanning is the primary way in (design D6). */
@Composable
fun EmptyState(onAdd: (AddMethod) -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        Button(
            onClick = { onAdd(AddMethod.QR) },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) {
            Text(stringResource(R.string.add_scan_qr))
        }
        TextButton(
            onClick = { onAdd(AddMethod.FILE) },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) {
            Text(stringResource(R.string.add_import_file))
        }
        TextButton(
            onClick = { onAdd(AddMethod.PASTE) },
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
        ) {
            Text(stringResource(R.string.add_paste_text))
        }
    }
}
