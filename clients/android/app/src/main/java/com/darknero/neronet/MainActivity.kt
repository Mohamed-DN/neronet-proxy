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
import android.view.Gravity
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.appcompat.widget.SwitchCompat
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.util.Date
import java.util.concurrent.Executors

class MainActivity : AppCompatActivity() {

    companion object {
        private const val MAX_PROFILE_BYTES = 64 * 1024
    }

    private val worker = Executors.newSingleThreadExecutor()
    private lateinit var store: ProfileStore
    private lateinit var controller: TunnelController
    private lateinit var list: ListView
    private lateinit var status: TextView
    private lateinit var toggle: SwitchCompat
    private lateinit var consoleButton: Button
    private lateinit var deleteButton: Button

    private var entries: List<ProfileStore.Entry> = emptyList()
    private var selectedId: String? = null
    private var awaitingVpnPermission: String? = null

    private val pickFile = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) readAndImport(uri)
    }

    private val vpnPermission = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val id = awaitingVpnPermission
        awaitingVpnPermission = null
        if (id != null && result.resultCode == RESULT_OK) {
            connect(id)
        } else {
            toast(R.string.vpn_denied)
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
        toggle = findViewById(R.id.connect_toggle)
        consoleButton = findViewById(R.id.open_console)
        deleteButton = findViewById(R.id.delete_profile)

        list.choiceMode = ListView.CHOICE_MODE_SINGLE
        list.setOnItemClickListener { _, _, position, _ ->
            selectedId = entries[position].id
            refresh()
        }
        findViewById<Button>(R.id.import_file).setOnClickListener { pickFile.launch(arrayOf("*/*")) }
        findViewById<Button>(R.id.paste_text).setOnClickListener { showPasteDialog() }
        // A click flips the switch first; onToggleClicked reads the new position.
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

    private fun onToggleClicked() {
        val id = selectedId
        if (id == null) {
            toggle.isChecked = false
            toast(R.string.select_first)
            return
        }
        if (toggle.isChecked) requestConnect(id) else disconnect(id)
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
        status.text = getString(R.string.state_connecting)
        background { controller.up(id, entry.profile, allIds) }
    }

    private fun disconnect(id: String) {
        background { controller.down(id) }
    }

    /** Runs a tunnel operation off the UI thread, then shows its failure and refreshes. */
    private fun background(work: () -> Unit) {
        worker.execute {
            val failure = try {
                work()
                null
            } catch (e: Exception) {
                e.message ?: e.javaClass.simpleName
            }
            runOnUiThread {
                if (failure != null) toast(R.string.tunnel_error, failure)
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
        toggle.isEnabled = entry != null
        toggle.isChecked = up
        consoleButton.isEnabled = entry?.profile?.consoleUrl != null
        deleteButton.isEnabled = entry != null

        status.text = when {
            entries.isEmpty() -> getString(R.string.no_profiles)
            entry == null -> getString(R.string.select_first)
            up -> getString(R.string.state_connected) + "\n" + trafficText(entry.id)
            else -> getString(R.string.state_disconnected)
        }
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
            toast(R.string.console_not_https)
            return
        }
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: ActivityNotFoundException) {
            toast(R.string.no_browser)
        }
    }

    private fun confirmDelete() {
        val entry = entries.find { it.id == selectedId } ?: return
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.delete_title, entry.name))
            .setMessage(R.string.delete_message)
            .setPositiveButton(R.string.delete) { _, _ ->
                selectedId = null
                background {
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
        AlertDialog.Builder(this)
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
                if (text == null) toast(R.string.read_failed) else importText(text)
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
            toast(R.string.read_failed)
            return
        }
        try {
            NeroNetProfile.parse(text)
        } catch (e: ProfileException) {
            AlertDialog.Builder(this)
                .setMessage(getString(R.string.import_failed, e.message ?: ""))
                .setPositiveButton(android.R.string.ok, null)
                .show()
            return
        }
        try {
            selectedId = store.add(text)
            toast(R.string.imported)
            refresh()
        } catch (e: IOException) {
            toast(R.string.read_failed)
        }
    }

    private fun toast(resId: Int, vararg args: Any) {
        Toast.makeText(this, getString(resId, *args), Toast.LENGTH_LONG).show()
    }
}
