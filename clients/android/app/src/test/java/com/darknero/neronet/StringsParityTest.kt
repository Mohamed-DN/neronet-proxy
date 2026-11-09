package com.darknero.neronet

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Document
import org.w3c.dom.Element
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory

/** Checks the English and Italian copy files against the rules in Global Constraints. */
class StringsParityTest {

    private fun load(path: String): Document =
        DocumentBuilderFactory.newInstance().newDocumentBuilder().parse(File(path))

    private val english = load("src/main/res/values/strings.xml")
    private val italian = load("src/main/res/values-it/strings.xml")

    private fun Document.tagged(tag: String): List<Element> {
        val nodes = getElementsByTagName(tag)
        return (0 until nodes.length).map { nodes.item(it) as Element }
    }

    private fun Element.tagged(tag: String): List<Element> {
        val nodes = getElementsByTagName(tag)
        return (0 until nodes.length).map { nodes.item(it) as Element }
    }

    /** Translatable plain strings, by name. */
    private fun strings(doc: Document): Map<String, String> =
        doc.tagged("string")
            .filter { it.getAttribute("translatable") != "false" }
            .associate { it.getAttribute("name") to it.textContent }

    /** Plural items: plural name, then quantity, then text. */
    private fun plurals(doc: Document): Map<String, Map<String, String>> =
        doc.tagged("plurals").associate { plural ->
            plural.getAttribute("name") to plural.tagged("item").associate { it.getAttribute("quantity") to it.textContent }
        }

    /** Every text in the file, including the non-translatable ones. */
    private fun everyText(doc: Document): List<String> =
        doc.tagged("string").map { it.textContent } +
            doc.tagged("plurals").flatMap { plural -> plural.tagged("item").map { it.textContent } }

    private val placeholder = Regex("""%(\d+\$)?[sd]""")

    private fun placeholdersOf(text: String): List<String> =
        placeholder.findAll(text).map { it.value }.sorted().toList()

    @Test
    fun sameTranslatableKeysInBothLanguages() {
        assertEquals(strings(english).keys, strings(italian).keys)
        assertEquals(plurals(english).keys, plurals(italian).keys)
    }

    @Test
    fun samePlaceholdersPerKey() {
        val englishStrings = strings(english)
        val italianStrings = strings(italian)
        for ((key, value) in englishStrings) {
            val other = italianStrings[key] ?: continue
            assertEquals("placeholders of $key", placeholdersOf(value), placeholdersOf(other))
        }
        val englishPlurals = plurals(english)
        val italianPlurals = plurals(italian)
        for ((name, items) in englishPlurals) {
            val expected = placeholdersOf(items.getValue("other"))
            for (item in items.values + italianPlurals.getValue(name).values) {
                assertEquals("placeholders of plural $name", expected, placeholdersOf(item))
            }
        }
    }

    @Test
    fun noAllCapsWords() {
        val word = Regex("[A-Za-z]{4,}")
        for (doc in listOf(english, italian)) {
            for (text in everyText(doc)) {
                for (match in word.findAll(text)) {
                    assertFalse("all-caps word ${match.value} in: $text", match.value == match.value.uppercase())
                }
            }
        }
    }

    @Test
    fun noThreeDots() {
        for (doc in listOf(english, italian)) {
            for (text in everyText(doc)) {
                assertFalse("three dots in: $text", text.contains("..."))
            }
        }
    }

    @Test
    fun requiredKeysExist() {
        val required = listOf(
            "status_protected_title", "action_disconnect", "error_timeout", "map_desc_gateway",
            "settings_always_on_body", "reason_other",
        )
        for (doc in listOf(english, italian)) {
            val names = strings(doc).keys
            for (key in required) assertTrue("missing $key", key in names)
            assertTrue("missing plural elapsed_minutes", "elapsed_minutes" in plurals(doc).keys)
        }
    }
}
