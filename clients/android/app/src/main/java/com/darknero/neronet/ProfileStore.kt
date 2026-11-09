package com.darknero.neronet

import java.io.File
import java.io.IOException
import java.security.SecureRandom

/** Profiles kept in the app's private storage, one `<id>.conf` file each. */
class ProfileStore(private val dir: File) {

    class Entry(val id: String, val name: String, val text: String, val profile: NeroNetProfile)

    /** All readable, valid profiles, sorted by file name. Unreadable files are skipped. */
    fun entries(): List<Entry> {
        val files = dir.listFiles { f -> f.isFile && f.name.endsWith(".conf") } ?: return emptyList()
        return files.sortedBy { it.name }.mapNotNull { file ->
            val id = file.name.removeSuffix(".conf")
            try {
                val text = file.readText()
                val profile = NeroNetProfile.parse(text)
                Entry(id, profile.deviceId ?: id, text, profile)
            } catch (e: Exception) {
                null
            }
        }
    }

    /** The saved profile whose device key is [publicKeyBase64], or null. Used to refuse a second copy. */
    fun findByPublicKey(publicKeyBase64: String): Entry? =
        entries().firstOrNull { it.profile.devicePublicKey == publicKeyBase64 }

    /** Saves a profile that has already been validated and returns its id. */
    @Throws(IOException::class)
    fun add(text: String): String {
        dir.mkdirs()
        val id = newId()
        val tmp = File(dir, "$id.tmp")
        tmp.writeText(text)
        val target = File(dir, "$id.conf")
        if (!tmp.renameTo(target)) {
            tmp.delete()
            throw IOException("cannot save the profile")
        }
        return id
    }

    fun delete(id: String) {
        File(dir, "$id.conf").delete()
    }

    companion object {
        private val random = SecureRandom()

        /** 12 lowercase hex characters: the tunnel name "nn_" + id stays within 15 characters. */
        fun newId(): String {
            val bytes = ByteArray(6)
            random.nextBytes(bytes)
            return bytes.joinToString("") { "%02x".format(it) }
        }
    }
}
