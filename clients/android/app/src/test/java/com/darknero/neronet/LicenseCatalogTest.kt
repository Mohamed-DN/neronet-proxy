package com.darknero.neronet

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Checks the licence screen against the shipped assets, the Gradle dependencies and the NOTICE file. */
class LicenseCatalogTest {

    // Gradle runs unit tests with the module directory as the working directory.
    private val assets = File("src/main/assets/licenses")
    private val notice = File("../NOTICE")

    private fun dependencyCoordinates(): List<String> {
        val pattern = Regex("""(?:implementation|debugImplementation|platform)\("([^"]+)"\)""")
        return File("build.gradle.kts").readLines().flatMap { line ->
            pattern.findAll(line).map { it.groupValues[1] }.toList()
        }
    }

    @Test
    fun everyAssetExists() {
        for (entry in LicenseCatalog.ALL) {
            assertTrue("missing licence asset ${entry.asset}", File(assets, entry.asset).isFile)
        }
    }

    @Test
    fun everyDependencyGroupIsCovered() {
        val prefixes = LicenseCatalog.ALL.flatMap { it.groupPrefixes }
        val uncovered = dependencyCoordinates()
            .map { it.substringBefore(':') }
            .filter { group -> prefixes.none { group.startsWith(it) } }
        assertTrue("dependency groups without a licence entry: $uncovered", uncovered.isEmpty())
    }

    @Test
    fun noticeMentionsEveryEntry() {
        val text = notice.readText()
        for (entry in LicenseCatalog.ALL) {
            assertTrue("NOTICE does not mention ${entry.name}", text.contains(entry.name))
        }
    }
}
