package com.darknero.neronet.tunnel

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestCoroutineScheduler

/** A clock that reads the test scheduler's virtual time, so timeouts are exact and instant. */
@OptIn(ExperimentalCoroutinesApi::class)
class FakeClock(private val scheduler: TestCoroutineScheduler) : Clock {
    override fun elapsedMs(): Long = scheduler.currentTime

    override fun wallMs(): Long = 1_700_000_000_000L + scheduler.currentTime
}
