package com.darknero.neronet.ui.apps

import android.content.Intent
import android.content.pm.PackageManager
import com.darknero.neronet.tunnel.AppRuleMode
import com.darknero.neronet.tunnel.AppRules
import java.util.Locale

/** One app the person can pick: its Android package name and the name shown in the launcher. */
data class AppEntry(val packageName: String, val label: String)

/** Apps whose label or package name contains [query], ignoring case and surrounding spaces. A blank query keeps all. */
fun filterApps(apps: List<AppEntry>, query: String): List<AppEntry> {
    val needle = query.trim().lowercase(Locale.ROOT)
    if (needle.isEmpty()) return apps
    return apps.filter {
        it.label.lowercase(Locale.ROOT).contains(needle) || it.packageName.lowercase(Locale.ROOT).contains(needle)
    }
}

/** [rules] with [packageName] added to the list, or removed when it is already there. */
fun toggled(rules: AppRules, packageName: String): AppRules =
    rules.copy(packages = if (packageName in rules.packages) rules.packages - packageName else rules.packages + packageName)

/** What a rule means in a sentence: nothing to count for "all apps", else the mode and the number of apps. */
sealed interface RulesSummary {
    data object AllApps : RulesSummary
    data class IncludeOnly(val count: Int) : RulesSummary
    data class Exclude(val count: Int) : RulesSummary
}

fun summaryOf(rules: AppRules): RulesSummary = when {
    !rules.active -> RulesSummary.AllApps
    rules.mode == AppRuleMode.INCLUDE_ONLY -> RulesSummary.IncludeOnly(rules.packages.size)
    else -> RulesSummary.Exclude(rules.packages.size)
}

/**
 * The apps that have a launcher icon, sorted by label, without this app. Needs the launcher query declared in
 * the manifest on Android 11 and later; no broad package permission is used.
 */
fun loadLaunchableApps(pm: PackageManager, ownPackage: String): List<AppEntry> {
    val launcher = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
    return pm.queryIntentActivities(launcher, 0)
        .mapNotNull { info ->
            val pkg = info.activityInfo?.packageName ?: return@mapNotNull null
            if (pkg == ownPackage) null else AppEntry(pkg, info.loadLabel(pm).toString())
        }
        .distinctBy { it.packageName }
        .sortedBy { it.label.lowercase(Locale.ROOT) }
}
