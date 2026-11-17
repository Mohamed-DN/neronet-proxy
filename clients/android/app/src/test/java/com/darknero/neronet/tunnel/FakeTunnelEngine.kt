package com.darknero.neronet.tunnel

import com.darknero.neronet.NeroNetProfile
import kotlinx.coroutines.delay

/** Stands in for GoBackend: records calls, and emits listener events the way the backend does. */
class FakeTunnelEngine : TunnelEngine {
    val ups = mutableListOf<String>()
    val downs = mutableListOf<String>()
    var upDelayMs = 0L
    var upFailure: Throwable? = null
    var statsResult: TunnelStats? = null

    private var listener: ((String, Boolean) -> Unit)? = null

    override fun setListener(listener: (profileId: String, up: Boolean) -> Unit) {
        this.listener = listener
    }

    override suspend fun up(profileId: String, profile: NeroNetProfile) {
        delay(upDelayMs)
        upFailure?.let {
            upFailure = null
            throw it
        }
        ups += profileId
        emit(profileId, true)
    }

    override suspend fun down(profileId: String) {
        downs += profileId
        emit(profileId, false)
    }

    override suspend fun stats(profileId: String): TunnelStats? = statsResult

    fun emit(profileId: String, up: Boolean) {
        listener?.invoke(profileId, up)
    }
}
