package com.darknero.neronet.ui.settings

import androidx.lifecycle.ViewModel
import com.darknero.neronet.SettingsStore
import com.darknero.neronet.ThemeMode
import kotlinx.coroutines.flow.StateFlow

class SettingsViewModel(private val settings: SettingsStore) : ViewModel() {

    val themeMode: StateFlow<ThemeMode> = settings.themeMode

    fun setThemeMode(mode: ThemeMode) = settings.setThemeMode(mode)
}
