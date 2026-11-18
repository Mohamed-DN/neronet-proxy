package com.darknero.neronet.ui.home

import com.darknero.neronet.tunnel.TunnelPhase

/**
 * When the Allaccio animation plays on the home screen.
 *
 * It plays once, on a transition seen while the app is running, from a phase the person saw as not connected
 * (Disconnected, Connecting, Disconnecting, Error) to Connected. It does not play:
 *  - at app start when the tunnel is already Connected (there is no previous phase to compare with);
 *  - on Reconnecting to Connected: the kill switch block was shown as "reconnecting", not as disconnected, and
 *    the tunnel never looked off, so a "you are connected" flourish would be false news;
 *  - on any change that stays connected (a new profile switches Connected to Connecting first, so it plays then).
 */
object AllaccioTrigger {
    fun shouldPlay(previous: TunnelPhase, next: TunnelPhase): Boolean =
        next is TunnelPhase.Connected && previous !is TunnelPhase.Connected && previous !is TunnelPhase.Reconnecting

    /** The animation is dropped as soon as the tunnel leaves Connected, so a stale one never plays later. */
    fun shouldCancel(next: TunnelPhase): Boolean = next !is TunnelPhase.Connected
}
