package com.darknero.neronet

import android.content.ActivityNotFoundException
import android.content.Intent
import android.graphics.Typeface
import android.net.Uri
import android.net.VpnService
import android.os.Bundle
import android.text.InputType
import android.text.format.DateFormat as AndroidDateFormat
import android.text.format.Formatter
import android.util.Log
import android.view.Gravity
import android.view.View
import android.widget.ArrayAdapter
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import com.google.android.material.materialswitch.MaterialSwitch
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.Date
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    companion object {
        private const val TAG = "NeroNet"
        private const val MAX_PROFILE_BYTES = 64 * 1024
    }

    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var store: ProfileStore
    private lateinit var controller: TunnelController
    private lateinit var list: ListView
    private lateinit var status: TextView
    private lateinit var errorRow: View
    private lateinit var errorText: TextView
    private lateinit var toggle: MaterialSwitch
    private lateinit var consoleButton: MaterialButton
    private lateinit var deleteButton: MaterialButton

    private var entries: List<ProfileStore.Entry> = emptyList()
    private var selectedId: String? = null
    private var awaitingVpnPermission: String? = null

    /** True while a tunnel operation runs: the switch is disabled until its result arrives. */
    private var busy = false

    /** The state a running operation is moving to: true for connecting, false for disconnecting. */
    private var pendingUp: Boolean? = null

    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) readAndImport(uri)
    }

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val id = awaitingVpnPermission
        awaitingVpnPermission = null
        if (id != null && result.resultCode == RESULT_OK) {
            connect(id)
        } else {
            showError(R.string.vpn_denied)
            refresh()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        store = ProfileStore(File(filesDir, "profiles"))
        controller = TunnelController(this)
        list = findViewById(R.id.profiles)
        status = findViewById(R.id.status)
        errorRow = findViewById(R.id.error_row)
        errorText = findViewById(R.id.error_text)
        toggle = findViewById(R.id.connect_toggle)
        consoleButton = findViewById(R.id.open_console)
        deleteButton = findViewById(R.id.delete_profile)

        list.choiceMode = ListView.CHOICE_MODE_SINGLE
        list.setOnItemClickListener { _, _, position, _ ->
            selectedId = entries[position].id
            refresh()
        }
        findViewById<MaterialButton>(R.id.import_file).setOnClickListener { pickFile.launch(arrayOf("*/*")) }
        findViewById<MaterialButton>(R.id.paste_text).setOnClickListener { showPasteDialog() }
        findViewById<MaterialButton>(R.id.dismiss_error).setOnClickListener {
            errorRow.visibility = View.GONE
        }
        toggle.setOnClickListener { onToggleClicked() }
        consoleButton.setOnClickListener { openConsole() }
        deleteButton.setOnClickListener { confirmDelete() }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }

    /**
     * The switch flips before this runs. Put it back to its old position and let the tunnel
     * result decide what it shows, so it never claims a connection that is not up.
     */
    private fun onToggleClicked() {
        val wantUp = toggle.isChecked
        toggle.isChecked = !wantUp
        val id = selectedId
        if (id == null) {
            showError(R.string.select_first)
            return
        }
        if (wantUp) requestConnect(id) else disconnect(id)
    }

    /** VpnService.prepare returns an intent the first time (or after another app took the VPN). */
    private fun requestConnect(id: String) {
        val permissionIntent = VpnService.prepare(this)
        if (permissionIntent == null) {
            connect(id)
        } else {
            awaitingVpnPermission = id
            vpnPermission.launch(permissionIntent)
        }
    }

    private fun connect(id: String) {
        val entry = entries.find { it.id == id } ?: return
        val allIds = entries.map { it.id }
        background(pending = true) { controller.up(id, entry.profile, allIds) }
    }

    private fun disconnect(id: String) {
        background(pending = false) { controller.down(id) }
    }

    /**
     * Runs a tunnel operation off the UI thread. The switch stays disabled until it ends; a failure
     * becomes an inline error that stays until the user dismisses it.
     */
    private fun background(pending: Boolean?, work: () -> Unit) {
        busy = true
        pendingUp = pending
        refresh()
        worker.execute {
            val failure: Exception? = try {
                work()
                null
            } catch (e: Exception) {
                e
            }
            runOnUiThread {
                busy = false
                pendingUp = null
                if (failure != null) {
                    // Log the exception type only: its message is English and may describe device state.
                    Log.w(TAG, "tunnel operation failed: ${failure.javaClass.simpleName}")
                    showError(getString(R.string.tunnel_error, getString(R.string.tunnel_reason_generic)))
                }
                refresh()
            }
        }
    }

    private fun refresh() {
        entries = store.entries()
        if (selectedId != null && entries.none { it.id == selectedId }) selectedId = null

        list.adapter = ArrayAdapter(this, android.R.layout.simple_list_item_single_choice, entries.map { it.name })
        val index = entries.indexOfFirst { it.id == selectedId }
        if (index >= 0) list.setItemChecked(index, true) else list.clearChoices()

        val entry = entries.getOrNull(index)
        val up = entry != null && controller.isUp(entry.id)
        val pending = pendingUp

        toggle.isEnabled = entry != null && !busy
        toggle.isChecked = up
        ViewCompat.setStateDescription(
            toggle,
            getString(
                when {
                    pending == true -> R.string.state_connecting
                    pending == false -> R.string.state_disconnecting
                    up -> R.string.state_connected
                    else -> R.string.state_disconnected
                },
            ),
        )
        consoleButton.isEnabled = entry?.profile?.consoleUrl != null
        deleteButton.isEnabled = entry != null && !busy

        status.text = when {
            entries.isEmpty() -> getString(R.string.no_profiles)
            entry == null -> getString(R.string.select_first)
            pending == true -> getString(R.string.state_connecting)
            pending == false -> getString(R.string.state_disconnecting)
            up -> getString(R.string.state_connected) + "\n" + trafficText(entry.id)
            else -> getString(R.string.state_disconnected)
        }
        status.setTextColor(
            ContextCompat.getColor(this, if (up && pending == null) R.color.nn_connected else R.color.nn_on_surface),
        )
    }

    private fun trafficText(id: String): String {
        val traffic = runCatching { controller.traffic(id) }.getOrNull() ?: return ""
        val handshake = if (traffic.lastHandshakeMillis > 0) {
            AndroidDateFormat.getTimeFormat(this).format(Date(traffic.lastHandshakeMillis))
        } else {
            getString(R.string.handshake_none)
        }
        return getString(
            R.string.traffic_line,
            Formatter.formatFileSize(this, traffic.rx),
            Formatter.formatFileSize(this, traffic.tx),
            handshake,
        )
    }

    private fun openConsole() {
        val url = entries.find { it.id == selectedId }?.profile?.consoleUrl ?: return
        if (!url.startsWith("https://", ignoreCase = true)) {
            showError(R.string.console_not_https)
            return
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: ActivityNotFoundException) {
            showError(R.string.no_browser)
        }
    }

    private fun confirmDelete() {
        val entry = entries.find { it.id == selectedId } ?: return
        MaterialAlertDialogBuilder(this)
            .setTitle(getString(R.string.delete_title, entry.name))
            .setMessage(R.string.delete_message)
            .setPositiveButton(R.string.delete) { _, _ ->
                selectedId = null
                background(pending = false) {
                    if (controller.isUp(entry.id)) controller.down(entry.id)
                    store.delete(entry.id)
                }
            }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun showPasteDialog() {
        val input = EditText(this).apply {
            minLines = 8
            gravity = Gravity.TOP or Gravity.START
            hint = getString(R.string.paste_hint)
            typeface = Typeface.MONOSPACE
            inputType = InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_FLAG_MULTI_LINE or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.paste_title)
            .setView(input)
            .setPositiveButton(R.string.import_action) { _, _ -> importText(input.text.toString()) }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun readAndImport(uri: Uri) {
        worker.execute {
            val text = try {
                readLimited(uri)
            } catch (e: IOException) {
                null
            }
            runOnUiThread {
                if (text == null) showError(R.string.read_failed) else importText(text)
            }
        }
    }

    @Throws(IOException::class)
    private fun readLimited(uri: Uri): String {
        val stream = contentResolver.openInputStream(uri) ?: throw IOException("no stream")
        stream.use { input ->
            val out = ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val n = input.read(buffer)
                if (n < 0) break
                out.write(buffer, 0, n)
                if (out.size() > MAX_PROFILE_BYTES) throw IOException("file too large")
            }
            return String(out.toByteArray(), Charsets.UTF_8)
        }
    }

    private fun importText(text: String) {
        if (text.length > MAX_PROFILE_BYTES) {
            showError(R.string.read_failed)
            return
        }
        try {
            NeroNetProfile.parse(text)
        } catch (e: Exception) {
            // The reason text is localized; the exception's English message stays out of the UI.
            MaterialAlertDialogBuilder(this)
                .setMessage(getString(R.string.import_failed, getString(ProfileErrorStrings.forThrowable(e))))
                .setPositiveButton(android.R.string.ok, null)
                .show()
            return
        }
        try {
            selectedId = store.add(text)
            Toast.makeText(this, R.string.imported, Toast.LENGTH_LONG).show()
            refresh()
        } catch (e: IOException) {
            showError(R.string.read_failed)
        }
    }

    /** Shows an error inline. It stays until the user dismisses it. */
    private fun showError(resId: Int) {
        showError(getString(resId))
    }

    private fun showError(message: String) {
        errorText.text = message
        errorRow.visibility = View.VISIBLE
    }
}
