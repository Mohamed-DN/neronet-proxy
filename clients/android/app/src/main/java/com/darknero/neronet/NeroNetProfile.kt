package com.darknero.neronet

import com.wireguard.config.BadConfigException
import com.wireguard.config.Config
import java.io.BufferedReader
import java.io.StringReader
import java.net.URI

/** Why a profile was rejected. The UI shows a localized text for each reason; see ProfileErrorStrings. */
enum class ProfileReason {
    VERSION,
    CONSOLE_NOT_HTTPS,
    REFUSED_SETTING,
    UNKNOWN_SETTING,
    UNKNOWN_SECTION,
    SYNTAX,
    BAD_VALUE,
    MISSING_PRIVATE_KEY,
    MISSING_PEER,
    MISSING_PUBLIC_KEY,
    WIREGUARD_REJECTED,
}

/**
 * A rejected profile. [message] is English for developers and logs only; it may name a setting but
 * never contains key material. The user sees the localized text for [reason] instead.
 */
class ProfileException(val reason: ProfileReason, message: String) : Exception(message)

/** The device's public key (base64), derived from its private key. Shown in details; used to find duplicates. */
val NeroNetProfile.devicePublicKey: String
    get() = config.`interface`.keyPair.publicKey.toBase64()

/**
 * A NeroNet profile (ADR 0029): a standard wg-quick file with NeroNet metadata in comment lines.
 *
 * The rules match pkg/profile/profile.go: version 1 is the newest supported, the console must be
 * https, and any key the app does not know is an error, because wg-quick's PostUp and friends
 * run commands on the device. The WireGuard library then builds the configuration it applies.
 */
class NeroNetProfile private constructor(
    /** 0 for a plain WireGuard file (no NeroNet-Profile line), 1 for a NeroNet profile. */
    val version: Int,
    /** The https address of the NeroNet console, from NeroNet-Console. */
    val consoleUrl: String?,
    /** The device identifier, from NeroNet-Device. */
    val deviceId: String?,
    /** The configuration the tunnel is brought up with. */
    val config: Config,
) {
    companion object {
        const val SUPPORTED_VERSION = 1

        // 32 bytes in base64 is always 44 characters ending with one '='.
        private val KEY_RE = Regex("^[A-Za-z0-9+/]{43}=$")
        private val IPV4_RE = Regex("^\\d{1,3}(\\.\\d{1,3}){3}$")
        private val IPV6_RE = Regex("^[0-9A-Fa-f:.]+$")
        private val KEEPALIVE_OFF_RE = Regex("(?i)^PersistentKeepalive\\s*=\\s*off$")

        private val INTERFACE_KEYS = setOf("privatekey", "address", "dns", "listenport", "mtu")
        private val PEER_KEYS = setOf("publickey", "presharedkey", "endpoint", "allowedips", "persistentkeepalive")
        private val RUNS_COMMANDS_OR_ROUTES = setOf("preup", "postup", "predown", "postdown", "table", "saveconfig")

        /** Parses a profile. Throws [ProfileException] for anything it would apply wrongly. */
        @Throws(ProfileException::class)
        fun parse(text: String): NeroNetProfile {
            var version = 0
            var consoleUrl: String? = null
            var deviceId: String? = null
            var section = ""
            var sawPrivateKey = false
            val peerHasKey = mutableListOf<Boolean>()

            for ((index, raw) in text.lines().withIndex()) {
                val line = index + 1
                val trimmed = raw.trim()
                if (trimmed.isEmpty()) continue

                if (trimmed.startsWith("#")) {
                    val body = trimmed.substring(1).trim()
                    val colon = body.indexOf(':')
                    if (colon >= 0) {
                        val key = body.substring(0, colon).trim()
                        val value = body.substring(colon + 1).trim()
                        when (key) {
                            "NeroNet-Profile" -> {
                                val v = value.toIntOrNull()
                                if (v == null || v < 1 || v > SUPPORTED_VERSION) {
                                    throw ProfileException(
                                        ProfileReason.VERSION,
                                        "NeroNet-Profile $value is not supported (newest: $SUPPORTED_VERSION); update the app",
                                    )
                                }
                                version = v
                            }
                            "NeroNet-Console" -> consoleUrl = requireHttps(value)
                            "NeroNet-Device" -> deviceId = value
                            // Other NeroNet-* lines are for newer apps; plain comments are ignored.
                        }
                    }
                    continue
                }

                if (trimmed.startsWith("[")) {
                    section = when (trimmed.lowercase()) {
                        "[interface]" -> "interface"
                        "[peer]" -> {
                            peerHasKey.add(false)
                            "peer"
                        }
                        else -> fail(line, ProfileReason.UNKNOWN_SECTION, "unknown section $trimmed")
                    }
                    continue
                }

                val eq = trimmed.indexOf('=')
                if (eq < 0) fail(line, ProfileReason.SYNTAX, "expected key = value")
                val rawKey = trimmed.substring(0, eq).trim()
                val key = rawKey.lowercase()
                val value = trimmed.substring(eq + 1).trim()

                if (key in RUNS_COMMANDS_OR_ROUTES) {
                    fail(line, ProfileReason.REFUSED_SETTING, "$rawKey is refused: a NeroNet profile cannot run commands or change routing")
                }
                val known = when (section) {
                    "interface" -> INTERFACE_KEYS
                    "peer" -> PEER_KEYS
                    else -> emptySet()
                }
                if (key !in known) fail(line, ProfileReason.UNKNOWN_SETTING, "$rawKey is not supported in a NeroNet profile")

                when ("$section.$key") {
                    "interface.privatekey" -> {
                        checkKey("PrivateKey", value, line)
                        sawPrivateKey = true
                    }
                    "interface.address" -> commaList(value).forEach { part ->
                        if (!isPrefix(part)) fail(line, ProfileReason.BAD_VALUE, "Address $part is not an IP prefix")
                    }
                    "interface.dns" -> commaList(value).forEach { part ->
                        if (!isIp(part)) {
                            fail(line, ProfileReason.BAD_VALUE, "DNS $part is not an IP address (search domains and host names are not supported)")
                        }
                    }
                    "interface.listenport" -> checkRange("ListenPort", value, 0, 65535, line)
                    "interface.mtu" -> checkRange("MTU", value, 0, 65535, line)
                    "peer.publickey" -> {
                        checkKey("PublicKey", value, line)
                        peerHasKey[peerHasKey.size - 1] = true
                    }
                    "peer.presharedkey" -> checkKey("PresharedKey", value, line)
                    "peer.endpoint" -> checkEndpoint(value, line)
                    "peer.allowedips" -> commaList(value).forEach { part ->
                        if (!isPrefix(part)) fail(line, ProfileReason.BAD_VALUE, "AllowedIPs $part is not an IP prefix")
                    }
                    "peer.persistentkeepalive" -> {
                        if (!value.equals("off", ignoreCase = true)) {
                            checkRange("PersistentKeepalive", value, 0, 65535, line)
                        }
                    }
                    else -> fail(line, ProfileReason.UNKNOWN_SETTING, "$rawKey is not supported in a NeroNet profile")
                }
            }

            if (!sawPrivateKey) throw ProfileException(ProfileReason.MISSING_PRIVATE_KEY, "[Interface] has no PrivateKey")
            if (peerHasKey.isEmpty()) throw ProfileException(ProfileReason.MISSING_PEER, "no [Peer] section")
            peerHasKey.forEachIndexed { i, hasKey ->
                if (!hasKey) throw ProfileException(ProfileReason.MISSING_PUBLIC_KEY, "peer ${i + 1} has no PublicKey")
            }

            // The library wants a number, while the Go parser (and so ADR 0029) accepts "off" as 0.
            val forLibrary = text.lines().joinToString("\n") { line ->
                if (KEEPALIVE_OFF_RE.matches(line.trim())) "PersistentKeepalive = 0" else line
            }
            val config = try {
                Config.parse(BufferedReader(StringReader(forLibrary)))
            } catch (e: BadConfigException) {
                throw ProfileException(
                    ProfileReason.WIREGUARD_REJECTED,
                    "WireGuard rejected the configuration (${e.section}: ${e.reason})",
                )
            } catch (e: Exception) {
                throw ProfileException(ProfileReason.WIREGUARD_REJECTED, "WireGuard rejected the configuration")
            }
            return NeroNetProfile(version, consoleUrl, deviceId, config)
        }

        private fun fail(line: Int, reason: ProfileReason, why: String): Nothing =
            throw ProfileException(reason, "line $line: $why")

        private fun requireHttps(value: String): String {
            val uri = try {
                URI(value)
            } catch (e: Exception) {
                throw ProfileException(ProfileReason.CONSOLE_NOT_HTTPS, "NeroNet-Console must be an https URL")
            }
            if (uri.scheme?.lowercase() != "https" || uri.host.isNullOrEmpty()) {
                throw ProfileException(ProfileReason.CONSOLE_NOT_HTTPS, "NeroNet-Console must be an https URL")
            }
            return value
        }

        private fun commaList(value: String): List<String> =
            value.split(",").map { it.trim() }.filter { it.isNotEmpty() }

        private fun checkKey(field: String, value: String, line: Int) {
            if (!KEY_RE.matches(value)) fail(line, ProfileReason.BAD_VALUE, "$field is not a 32-byte base64 key")
        }

        private fun checkRange(field: String, value: String, min: Int, max: Int, line: Int) {
            val n = value.toIntOrNull()
            if (n == null || n < min || n > max) {
                fail(line, ProfileReason.BAD_VALUE, "$field must be an integer from $min to $max")
            }
        }

        private fun checkEndpoint(value: String, line: Int) {
            val colon = value.lastIndexOf(':')
            if (colon <= 0 || colon == value.length - 1) fail(line, ProfileReason.BAD_VALUE, "Endpoint must be host:port")
            if (value.substring(0, colon).trim('[', ']').isEmpty()) fail(line, ProfileReason.BAD_VALUE, "Endpoint has no host")
            val port = value.substring(colon + 1).toIntOrNull()
            if (port == null || port < 1 || port > 65535) {
                fail(line, ProfileReason.BAD_VALUE, "Endpoint port must be from 1 to 65535")
            }
        }

        private fun isIpv4(s: String): Boolean =
            IPV4_RE.matches(s) && s.split(".").all { it.toInt() <= 255 }

        private fun isIpv6(s: String): Boolean = s.contains(':') && IPV6_RE.matches(s)

        private fun isIp(s: String): Boolean = isIpv4(s) || isIpv6(s)

        private fun isPrefix(s: String): Boolean {
            val slash = s.lastIndexOf('/')
            if (slash <= 0) return false
            val address = s.substring(0, slash)
            val bits = s.substring(slash + 1).toIntOrNull() ?: return false
            return when {
                isIpv4(address) -> bits in 0..32
                isIpv6(address) -> bits in 0..128
                else -> false
            }
        }
    }
}
