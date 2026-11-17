package com.darknero.neronet

import java.net.URI

/**
 * NeroDrop (ADR 0033) is a page of the console. The app only opens it; the page does the cryptography and
 * keeps the file key in the URL fragment, so the app builds no fragment and handles no key.
 */
object NeroDrop {
    /**
     * The page's address: the console's origin (https scheme, host, port) plus "/drop". The console URL's own
     * path, query and fragment are dropped. Null when there is no https console URL.
     */
    fun url(consoleUrl: String?): String? {
        if (consoleUrl == null) return null
        val uri = try {
            URI(consoleUrl)
        } catch (e: Exception) {
            return null
        }
        if (uri.scheme?.lowercase() != "https" || uri.host.isNullOrEmpty()) return null
        val port = if (uri.port >= 0) ":" + uri.port else ""
        return "https://" + uri.host + port + "/drop"
    }
}
