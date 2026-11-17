package com.darknero.neronet.tunnel

/** How the per-app split tunnelling list is used (ADR 0035). */
enum class AppRuleMode {
    /** Every app uses the tunnel. */
    ALL,

    /** Only the listed apps use the tunnel; the rest go straight to the network. */
    INCLUDE_ONLY,

    /** Every app uses the tunnel except the listed ones. */
    EXCLUDE,
}

/**
 * The split tunnelling choice for one profile, by Android package name. It lives on the device only; the
 * profile file never carries it. An empty list means no rule: a list-less "include only" would otherwise
 * be read by Android as "all apps", which is the opposite of what the person picked.
 */
data class AppRules(val mode: AppRuleMode = AppRuleMode.ALL, val packages: Set<String> = emptySet()) {
    val active: Boolean
        get() = mode != AppRuleMode.ALL && packages.isNotEmpty()

    companion object {
        val NONE = AppRules()
    }
}
