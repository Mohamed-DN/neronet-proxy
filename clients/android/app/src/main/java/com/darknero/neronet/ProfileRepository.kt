package com.darknero.neronet

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The saved profiles and which one is selected. The file store is the record; these flows are its view. */
class ProfileRepository(
    private val store: ProfileStore,
    private val settings: SettingsStore,
) {
    private val all = MutableStateFlow<List<ProfileSummary>>(emptyList())
    val profiles: StateFlow<List<ProfileSummary>> = all.asStateFlow()

    private val selected = MutableStateFlow<String?>(null)
    val selectedId: StateFlow<String?> = selected.asStateFlow()

    init {
        refresh()
    }

    fun refresh() {
        val summaries = store.entries().map { ProfileSummary.from(it.id, it.profile) }
        all.value = summaries
        val remembered = settings.lastProfileId
        selected.value = when {
            remembered != null && summaries.any { it.id == remembered } -> remembered
            else -> summaries.firstOrNull()?.id
        }
    }

    fun select(id: String) {
        settings.lastProfileId = id
        selected.value = id
    }

    fun profile(id: String): NeroNetProfile? = store.entries().firstOrNull { it.id == id }?.profile

    fun findByPublicKey(key: String): ProfileSummary? =
        store.findByPublicKey(key)?.let { ProfileSummary.from(it.id, it.profile) }

    /** Saves a validated profile and returns its id. */
    fun add(text: String): String {
        val id = store.add(text)
        refresh()
        return id
    }

    fun delete(id: String) {
        store.delete(id)
        if (settings.lastProfileId == id) settings.lastProfileId = null
        refresh()
    }
}
