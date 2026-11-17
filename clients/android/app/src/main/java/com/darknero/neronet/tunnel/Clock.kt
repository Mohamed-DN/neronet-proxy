package com.darknero.neronet.tunnel

import android.os.SystemClock

/** Two clocks: elapsed time for timeouts (immune to wall-clock changes), wall time for "since" labels. */
interface Clock {
    fun elapsedMs(): Long
    fun wallMs(): Long
}

object SystemClockSource : Clock {
    override fun elapsedMs(): Long = SystemClock.elapsedRealtime()
    override fun wallMs(): Long = System.currentTimeMillis()
}
