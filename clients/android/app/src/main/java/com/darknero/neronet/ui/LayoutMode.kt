package com.darknero.neronet.ui

/** Phone-style single column, or the two panes of a tablet in landscape (design D6). */
enum class LayoutMode {
    SINGLE,
    TWO_PANE;

    companion object {
        /** TWO_PANE from 840 dp wide, or from 600 dp wide when the window is landscape. */
        fun of(widthDp: Int, heightDp: Int): LayoutMode = when {
            widthDp >= 840 -> TWO_PANE
            widthDp >= 600 && widthDp > heightDp -> TWO_PANE
            else -> SINGLE
        }
    }
}
