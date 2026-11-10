package com.darknero.neronet.ui

import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.saveable.Saver

enum class Route { HOME, PROFILES, ADD_PROFILE, PASTE_PROFILE, SETTINGS, LICENSES }

/**
 * A back stack of routes. The bottom entry is always HOME. Survives rotation through [Saver] (route names
 * only, never profile text).
 */
class NavState(initial: List<Route> = listOf(Route.HOME)) {
    private val stack = mutableStateListOf<Route>().apply {
        addAll(initial.ifEmpty { listOf(Route.HOME) })
    }

    val current: Route
        get() = stack.last()

    fun push(route: Route) {
        stack.add(route)
    }

    /** Removes the top route. Returns false (and does nothing) at HOME. */
    fun pop(): Boolean {
        if (stack.size <= 1) return false
        stack.removeAt(stack.lastIndex)
        return true
    }

    /** Pops until [route] is on top. A route that is not on the stack changes nothing. */
    fun popTo(route: Route) {
        val index = stack.indexOf(route)
        if (index < 0) return
        while (stack.size > index + 1) stack.removeAt(stack.lastIndex)
    }

    companion object {
        val Saver: Saver<NavState, List<String>> = Saver(
            save = { state -> state.stack.map { it.name } },
            restore = { names -> NavState(names.map { Route.valueOf(it) }) },
        )
    }
}
