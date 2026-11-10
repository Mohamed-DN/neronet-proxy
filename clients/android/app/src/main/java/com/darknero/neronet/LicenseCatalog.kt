package com.darknero.neronet

/** One licence shown on the licences screen. [asset] is a file under assets/licenses. */
data class LicenseEntry(
    val name: String,
    val license: String,
    val asset: String,
    /** Maven group prefixes this entry covers; the test checks every dependency group is covered. */
    val groupPrefixes: List<String>,
)

object LicenseCatalog {
    val ALL: List<LicenseEntry> = listOf(
        LicenseEntry("NeroNet", "GNU Affero General Public License v3.0", "agpl-3.0-neronet.txt", emptyList()),
        LicenseEntry(
            "WireGuard tunnel library for Android",
            "Apache License 2.0",
            "apache-2.0.txt",
            listOf("com.wireguard.android"),
        ),
        LicenseEntry(
            "wireguard-go, inside the tunnel library",
            "MIT License",
            "mit-wireguard-go.txt",
            emptyList(),
        ),
        LicenseEntry(
            "Go standard library, inside the tunnel library",
            "BSD 3-Clause License",
            "bsd-3-go.txt",
            emptyList(),
        ),
        LicenseEntry("AndroidX and Jetpack Compose", "Apache License 2.0", "apache-2.0.txt", listOf("androidx.")),
        LicenseEntry(
            "Kotlin and kotlinx.coroutines",
            "Apache License 2.0",
            "apache-2.0.txt",
            listOf("org.jetbrains.kotlin", "org.jetbrains.kotlinx"),
        ),
        LicenseEntry(
            "ZXing and ZXing Android Embedded",
            "Apache License 2.0",
            "apache-2.0.txt",
            listOf("com.journeyapps", "com.google.zxing"),
        ),
        LicenseEntry("Inter typeface", "SIL Open Font License 1.1", "OFL-Inter.txt", emptyList()),
    )
}
